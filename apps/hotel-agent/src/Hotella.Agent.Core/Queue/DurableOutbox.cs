using System.Globalization;
using Microsoft.Data.Sqlite;

namespace Hotella.Agent.Core.Queue;

/// <summary>One raw vendor message waiting to be forwarded (the link's <c>message</c> frame without its type).</summary>
public sealed record QueuedMessage(
    long SequenceNo,
    string SourceMessageId,
    string MessageType,
    string? OccurredAt,
    string PayloadJson);

/// <summary>
/// The agent's durable, ordered outbound queue (ADR-0017 §4) in SQLite with WAL: every message gets the next sequence
/// number and is committed before it is sent; it is deleted only when the platform acknowledges it (cumulative acks).
/// Survives restarts and power loss. Old messages are evicted only past the retention window, oldest first, and the
/// eviction is reported so it can raise an alert — never silently.
/// </summary>
public sealed class DurableOutbox : IDisposable
{
    private readonly SqliteConnection _db;
    private readonly Lock _gate = new();

    private DurableOutbox(SqliteConnection db) => _db = db;

    /// <summary>Opens (or creates) the queue file; <c>":memory:"</c> for tests.</summary>
    public static DurableOutbox Open(string path)
    {
        var builder = new SqliteConnectionStringBuilder
        {
            DataSource = path,
            Mode = path == ":memory:" ? SqliteOpenMode.Memory : SqliteOpenMode.ReadWriteCreate,
            Cache = SqliteCacheMode.Private,
        };
        var db = new SqliteConnection(builder.ToString());
        db.Open();
        Exec(db, "PRAGMA journal_mode=WAL;");
        Exec(db, "PRAGMA synchronous=FULL;");
        Exec(db, """
            CREATE TABLE IF NOT EXISTS messages (
              sequence_no INTEGER PRIMARY KEY,
              source_message_id TEXT NOT NULL,
              message_type TEXT NOT NULL,
              occurred_at TEXT NULL,
              payload TEXT NOT NULL,
              enqueued_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS executed_commands (
              command_id TEXT PRIMARY KEY,
              status TEXT NOT NULL,
              error TEXT NULL,
              executed_at TEXT NOT NULL
            );
            """);
        return new DurableOutbox(db);
    }

    /// <summary>Appends a message with the next sequence number, durably (committed before returning).</summary>
    public QueuedMessage Append(string sourceMessageId, string messageType, string? occurredAt, string payloadJson)
    {
        lock (_gate)
        {
            using var tx = _db.BeginTransaction();
            var next = NextSequence(tx);
            using (var insert = Command(tx, """
                INSERT INTO messages (sequence_no, source_message_id, message_type, occurred_at, payload, enqueued_at)
                VALUES ($seq, $source, $type, $occurred, $payload, $now)
                """))
            {
                insert.Parameters.AddWithValue("$seq", next);
                insert.Parameters.AddWithValue("$source", sourceMessageId);
                insert.Parameters.AddWithValue("$type", messageType);
                insert.Parameters.AddWithValue("$occurred", (object?)occurredAt ?? DBNull.Value);
                insert.Parameters.AddWithValue("$payload", payloadJson);
                insert.Parameters.AddWithValue("$now", DateTimeOffset.UtcNow.ToString("O", CultureInfo.InvariantCulture));
                insert.ExecuteNonQuery();
            }
            SetMeta(tx, "next_sequence", (next + 1).ToString(CultureInfo.InvariantCulture));
            tx.Commit();
            return new QueuedMessage(next, sourceMessageId, messageType, occurredAt, payloadJson);
        }
    }

    /// <summary>Cumulative acknowledgement: everything up to <paramref name="sequence"/> is durable on the platform.</summary>
    public int AckThrough(long sequence)
    {
        lock (_gate)
        {
            using var tx = _db.BeginTransaction();
            using var delete = Command(tx, "DELETE FROM messages WHERE sequence_no <= $seq");
            delete.Parameters.AddWithValue("$seq", sequence);
            var removed = delete.ExecuteNonQuery();
            var acked = long.Parse(GetMeta(tx, "acked_through") ?? "0", CultureInfo.InvariantCulture);
            if (sequence > acked)
                SetMeta(tx, "acked_through", sequence.ToString(CultureInfo.InvariantCulture));
            tx.Commit();
            return removed;
        }
    }

    /// <summary>Messages still waiting, in order, from <paramref name="fromSequence"/> on.</summary>
    public IReadOnlyList<QueuedMessage> Pending(long fromSequence = 0, int limit = 500)
    {
        lock (_gate)
        {
            using var select = Command(null, """
                SELECT sequence_no, source_message_id, message_type, occurred_at, payload FROM messages
                WHERE sequence_no >= $from ORDER BY sequence_no LIMIT $limit
                """);
            select.Parameters.AddWithValue("$from", fromSequence);
            select.Parameters.AddWithValue("$limit", limit);
            using var reader = select.ExecuteReader();
            var list = new List<QueuedMessage>();
            while (reader.Read())
                list.Add(new QueuedMessage(
                    reader.GetInt64(0),
                    reader.GetString(1),
                    reader.GetString(2),
                    reader.IsDBNull(3) ? null : reader.GetString(3),
                    reader.GetString(4)));
            return list;
        }
    }

    public long Depth
    {
        get
        {
            lock (_gate)
            {
                using var count = Command(null, "SELECT COUNT(*) FROM messages");
                return (long)count.ExecuteScalar()!;
            }
        }
    }

    /// <summary>The oldest sequence still buffered (sent in <c>hello</c>), or null when empty.</summary>
    public long? FirstBuffered
    {
        get
        {
            lock (_gate)
            {
                using var min = Command(null, "SELECT MIN(sequence_no) FROM messages");
                var v = min.ExecuteScalar();
                return v is null or DBNull ? null : (long)v;
            }
        }
    }

    /// <summary>
    /// Drops messages older than <paramref name="retention"/> (oldest first) and returns how many — the caller
    /// raises an alert; the platform will see the sequence jump and open a <c>sequence_gap</c> exception.
    /// </summary>
    public int Evict(TimeSpan retention)
    {
        lock (_gate)
        {
            using var delete = Command(null, "DELETE FROM messages WHERE enqueued_at < $cutoff");
            delete.Parameters.AddWithValue("$cutoff",
                DateTimeOffset.UtcNow.Subtract(retention).ToString("O", CultureInfo.InvariantCulture));
            return delete.ExecuteNonQuery();
        }
    }

    // ---- commands already executed (idempotency across restarts) ----

    public (string status, string? error)? ExecutedCommand(string commandId)
    {
        lock (_gate)
        {
            using var select = Command(null, "SELECT status, error FROM executed_commands WHERE command_id = $id");
            select.Parameters.AddWithValue("$id", commandId);
            using var reader = select.ExecuteReader();
            return reader.Read() ? (reader.GetString(0), reader.IsDBNull(1) ? null : reader.GetString(1)) : null;
        }
    }

    public void RecordCommand(string commandId, string status, string? error)
    {
        lock (_gate)
        {
            using var insert = Command(null, """
                INSERT OR IGNORE INTO executed_commands (command_id, status, error, executed_at)
                VALUES ($id, $status, $error, $now)
                """);
            insert.Parameters.AddWithValue("$id", commandId);
            insert.Parameters.AddWithValue("$status", status);
            insert.Parameters.AddWithValue("$error", (object?)error ?? DBNull.Value);
            insert.Parameters.AddWithValue("$now", DateTimeOffset.UtcNow.ToString("O", CultureInfo.InvariantCulture));
            insert.ExecuteNonQuery();
        }
    }

    public void Dispose() => _db.Dispose();

    // ---- helpers ----

    private long NextSequence(SqliteTransaction tx)
    {
        var stored = GetMeta(tx, "next_sequence");
        if (stored is not null) return long.Parse(stored, CultureInfo.InvariantCulture);
        using var max = Command(tx, "SELECT COALESCE(MAX(sequence_no), 0) + 1 FROM messages");
        return (long)max.ExecuteScalar()!;
    }

    private string? GetMeta(SqliteTransaction? tx, string key)
    {
        using var select = Command(tx, "SELECT value FROM meta WHERE key = $key");
        select.Parameters.AddWithValue("$key", key);
        return select.ExecuteScalar() as string;
    }

    private void SetMeta(SqliteTransaction tx, string key, string value)
    {
        using var upsert = Command(tx, """
            INSERT INTO meta (key, value) VALUES ($key, $value)
            ON CONFLICT(key) DO UPDATE SET value = excluded.value
            """);
        upsert.Parameters.AddWithValue("$key", key);
        upsert.Parameters.AddWithValue("$value", value);
        upsert.ExecuteNonQuery();
    }

    private SqliteCommand Command(SqliteTransaction? tx, string sql)
    {
        var cmd = _db.CreateCommand();
        cmd.CommandText = sql;
        cmd.Transaction = tx;
        return cmd;
    }

    private static void Exec(SqliteConnection db, string sql)
    {
        using var cmd = db.CreateCommand();
        cmd.CommandText = sql;
        cmd.ExecuteNonQuery();
    }
}
