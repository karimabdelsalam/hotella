using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json.Nodes;
using Hotella.Agent.Core.Connectors;
using Hotella.Agent.Core.Hosting;
using Hotella.Agent.Core.Json;
using Hotella.Agent.Core.Link;
using Microsoft.Data.Sqlite;
using Microsoft.Extensions.Logging;

namespace Hotella.Agent.OperaDb;

/// <summary>
/// <c>OPERA5_DB</c> (ADR-0019; guide §6): answers the platform's predefined reads (link protocol 2) with data contract
/// v1 statements, refuses everything while the account's privileges are wider than SELECT on the contract (checked at
/// start and daily), and — only when configured, because OWS is absent — polls the arrival window and forwards changed
/// reservations as <c>OPERA_DB_RESERVATION</c> messages in the OWS reservation shape. It never writes to OPERA: no
/// statement can, the session is read-only, and a writable account is refused.
/// </summary>
public sealed class OperaDbAdapter : IConnectorAdapter
{
    public const string ConnectorCode = "OPERA5_DB";
    public const string MessageType = "OPERA_DB_RESERVATION";
    private static readonly TimeSpan PrivilegeCheckEvery = TimeSpan.FromDays(1);

    private readonly OperaDbSettings _settings;
    private readonly string _instanceId;
    private readonly IOperaDataSource _source;
    private readonly ILogger _log;
    private readonly SqliteConnection _db;
    private readonly Func<DateTimeOffset> _now;
    private volatile string? _refusal = "privileges not checked yet";
    private volatile string? _lastError;

    public OperaDbAdapter(
        OperaDbSettings settings, string instanceId, IOperaDataSource source, string statePath, ILogger logger,
        Func<DateTimeOffset>? now = null)
    {
        ArgumentNullException.ThrowIfNull(settings);
        _settings = settings;
        _instanceId = instanceId;
        _source = source;
        _log = logger;
        _now = now ?? (() => DateTimeOffset.UtcNow);
        _db = new SqliteConnection(new SqliteConnectionStringBuilder
        {
            DataSource = statePath,
            Mode = statePath == ":memory:" ? SqliteOpenMode.Memory : SqliteOpenMode.ReadWriteCreate,
        }.ToString());
        _db.Open();
        using var create = _db.CreateCommand();
        create.CommandText = """
            PRAGMA journal_mode = WAL;
            CREATE TABLE IF NOT EXISTS reservations (
              reservation_id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, status TEXT NOT NULL, seen_at TEXT NOT NULL);
            """;
        create.ExecuteNonQuery();
    }

    public int Polls { get; private set; }
    public long Forwarded { get; private set; }
    public string? Refusal => _refusal;

    public bool Up => _refusal is null && _lastError is null;
    public string? Problem => _refusal ?? _lastError;

    /// <summary>None, ever: the OPERA database is read-only for Hotella (ADR-0019).</summary>
    public IReadOnlyList<ICommandHandler> Commands() => [];

    /// <summary>The predefined reads this connector serves (the manifest's queries).</summary>
    public IReadOnlyList<IQueryHandler> Queries() =>
    [
        new Handler("LOOKUP_RESERVATION", async (p, ct) =>
        {
            var byId = Param(p, "reservation_id");
            var statement = byId is not null ? DataContract.ReservationById : DataContract.ReservationByConfirmation;
            var binds = byId is not null
                ? Binds(("reservation_id", byId))
                : Binds(("confirmation_number", Param(p, "confirmation_number") ?? throw new FormatException("a confirmation number or reservation id is required")));
            return await ReadAsync(statement, binds, RowMapper.Reservation, ct).ConfigureAwait(false);
        }),
        new Handler("LIST_ARRIVALS", (p, ct) => ReadAsync(DataContract.Arrivals,
            Binds(("from_date", Day(p, "from")), ("to_date", Day(p, "to"))), RowMapper.Reservation, ct)),
        new Handler("IN_HOUSE", (_, ct) => ReadAsync(DataContract.InHouse, Binds(), RowMapper.Reservation, ct)),
        new Handler("LOOKUP_PROFILE", (p, ct) => ReadAsync(DataContract.Profile,
            Binds(("name_id", Param(p, "profile_id") ?? throw new FormatException("profile_id is required"))),
            RowMapper.Profile, ct)),
        new Handler("ROOM_INVENTORY", (_, ct) => ReadAsync(DataContract.Rooms, Binds(), RowMapper.Room, ct)),
    ];

    /// <summary>Privilege self-check now and every day; change polling when configured.</summary>
    public async Task RunAsync(IMessagePublisher publisher, CancellationToken ct)
    {
        var nextCheck = DateTimeOffset.MinValue;
        var interval = _settings.ChangePolling ? TimeSpan.FromSeconds(_settings.PollSeconds) : TimeSpan.FromMinutes(5);
        using var timer = new PeriodicTimer(interval);
        do
        {
            try
            {
                if (_now() >= nextCheck)
                {
                    await CheckPrivilegesAsync(ct).ConfigureAwait(false);
                    nextCheck = _now() + PrivilegeCheckEvery;
                }
                if (_settings.ChangePolling && _refusal is null) await PollOnceAsync(publisher, ct).ConfigureAwait(false);
            }
            catch (OperationCanceledException) when (ct.IsCancellationRequested)
            {
                return;
            }
#pragma warning disable CA1031 // A failed check or poll is retried at the next tick; the agent keeps running.
            catch (Exception e)
#pragma warning restore CA1031
            {
                _lastError = $"OPERA database unreachable ({e.GetType().Name})";
                _log.LogWarning("OPERA database: {Reason}", e.Message);
            }
        }
        while (await timer.WaitForNextTickAsync(ct).ConfigureAwait(false));
    }

    /// <summary>Guide §6.4 rule 3: anything beyond CREATE SESSION + SELECT on the contract refuses every read.</summary>
    public async Task<IReadOnlyList<string>> CheckPrivilegesAsync(CancellationToken ct)
    {
        var problems = PrivilegeCheck.Problems(await _source.PrivilegesAsync(ct).ConfigureAwait(false), _settings.SchemaOwner);
        _lastError = null;
        if (problems.Count == 0)
        {
            if (_refusal is not null) _log.LogInformation("OPERA database account is read-only: reads enabled");
            _refusal = null;
        }
        else
        {
            _refusal = "the OPERA account has more than read access: " + string.Join("; ", problems);
            _log.LogCritical("{Refusal}. Reads are refused until the hotel's DBA removes it.", _refusal);
        }
        return problems;
    }

    /// <summary>One poll of the arrival window; returns how many changed reservations were forwarded.</summary>
    public async Task<int> PollOnceAsync(IMessagePublisher publisher, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(publisher);
        if (_refusal is not null) throw new QueryRefusedException(_refusal);
        var today = DateOnly.FromDateTime(_now().UtcDateTime);
        var rows = await _source.QueryAsync(DataContract.ArrivalsWithGuest,
            Binds(("from_date", today.AddDays(-1)), ("to_date", today.AddDays(_settings.WindowDays))),
            LinkOptions.MaxQueryRows, ct).ConfigureAwait(false);
        Polls++;
        _lastError = null;
        var forwarded = 0;
        foreach (var row in rows.Rows)
            if (Forward(publisher, row)) forwarded++;
        Forwarded += forwarded;
        return forwarded;
    }

    private async Task<QueryAnswer> ReadAsync(
        ContractStatement statement, IReadOnlyDictionary<string, object?> binds, Func<DbRow, JsonObject> map,
        CancellationToken ct)
    {
        if (_refusal is not null) throw new QueryRefusedException(_refusal);
        var rows = await _source.QueryAsync(statement, binds, LinkOptions.MaxQueryRows, ct).ConfigureAwait(false);
        _lastError = null;
        return new QueryAnswer(rows.Rows.Select(map).ToList(), rows.Truncated);
    }

    private bool Forward(IMessagePublisher publisher, DbRow row)
    {
        var reservation = RowMapper.Reservation(row);
        var id = reservation["reservation_id"]!.GetValue<string>();
        var action = reservation["status"]!.GetValue<string>() switch
        {
            "CANCELLED" => "CANCEL",
            "NO_SHOW" => "NOSHOW",
            _ => "ACTIVE",
        };
        var first = RowMapper.Text(row["FIRST"]);
        if (action == "ACTIVE" && first is null)
        {
            // The message shape needs the guest's first name; without one nothing is guessed.
            _log.LogWarning("reservation {Reservation} has no first name; not forwarded", id);
            return false;
        }
        var body = new JsonObject
        {
            ["reservationId"] = id,
            ["confirmationNo"] = reservation["confirmation_number"]?.DeepClone(),
            ["arrivalDate"] = reservation["arrival_date"]!.DeepClone(),
            ["departureDate"] = reservation["departure_date"]!.DeepClone(),
            ["adults"] = reservation["adults"]!.DeepClone(),
            ["children"] = reservation["children"]!.DeepClone(),
            ["roomNumber"] = reservation["room_number"]?.DeepClone(),
            ["ratePlanCode"] = reservation["rate_code"]?.DeepClone(),
            ["marketCode"] = reservation["market_code"]?.DeepClone(),
            ["guest"] = new JsonObject
            {
                ["profileId"] = reservation["profile_id"]?.DeepClone(),
                ["firstName"] = first,
                ["lastName"] = RowMapper.Text(row["LAST"]),
                ["title"] = RowMapper.Text(row["TITLE"]),
                ["language"] = RowMapper.Text(row["LANGUAGE"]),
                ["vipCode"] = RowMapper.Text(row["VIP_STATUS"]),
            },
        };
        foreach (var key in body.Where(kv => kv.Value is null).Select(kv => kv.Key).ToList()) body.Remove(key);
        var guest = (JsonObject)body["guest"]!;
        foreach (var key in guest.Where(kv => kv.Value is null).Select(kv => kv.Key).ToList()) guest.Remove(key);
        var fingerprint = Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(
            action + "\n" + CanonicalJson.Serialize(body))));
        var known = Known(id);
        if (known?.fingerprint == fingerprint) return false;
        if (action != "ACTIVE" && (known is null || known.Value.status is "CANCEL" or "NOSHOW"))
        {
            Remember(id, fingerprint, action);
            return false;
        }
        var owsAction = action == "ACTIVE" ? (known is null ? "NEW" : "CHANGE") : action;
        var payload = new JsonObject
        {
            ["action"] = owsAction,
            ["modifiedAt"] = _now().UtcDateTime.ToString("yyyy-MM-ddTHH:mm:ss.fffZ", CultureInfo.InvariantCulture),
            ["reservation"] = action == "ACTIVE" ? body : new JsonObject { ["reservationId"] = id },
        };
        var messageId = "opera-db-" + Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(
            _instanceId + "\n" + id + "\n" + owsAction + "\n" + fingerprint)));
        publisher.Publish(messageId, MessageType, null, payload.ToJsonString());
        Remember(id, fingerprint, action);
        return true;
    }

    private (string fingerprint, string status)? Known(string reservationId)
    {
        using var q = _db.CreateCommand();
        q.CommandText = "SELECT fingerprint, status FROM reservations WHERE reservation_id = $id";
        q.Parameters.AddWithValue("$id", reservationId);
        using var reader = q.ExecuteReader();
        return reader.Read() ? (reader.GetString(0), reader.GetString(1)) : null;
    }

    private void Remember(string reservationId, string fingerprint, string status)
    {
        using var q = _db.CreateCommand();
        q.CommandText = """
            INSERT INTO reservations (reservation_id, fingerprint, status, seen_at) VALUES ($id, $f, $s, $t)
            ON CONFLICT (reservation_id) DO UPDATE SET fingerprint = $f, status = $s, seen_at = $t
            """;
        q.Parameters.AddWithValue("$id", reservationId);
        q.Parameters.AddWithValue("$f", fingerprint);
        q.Parameters.AddWithValue("$s", status);
        q.Parameters.AddWithValue("$t", _now().ToString("O", CultureInfo.InvariantCulture));
        q.ExecuteNonQuery();
    }

    private static Dictionary<string, object?> Binds(params (string name, object? value)[] values) =>
        values.ToDictionary(v => v.name, v => v.value, StringComparer.Ordinal);

    private static string? Param(JsonObject p, string name) =>
        p[name] is JsonValue v && v.TryGetValue<string>(out var s) && s.Length > 0 ? s : null;

    private static DateOnly Day(JsonObject p, string name) =>
        DateOnly.TryParseExact(Param(p, name), "yyyy-MM-dd", CultureInfo.InvariantCulture, DateTimeStyles.None, out var d)
            ? d
            : throw new FormatException($"{name} must be a date (yyyy-MM-dd)");

    public void Dispose()
    {
        _db.Dispose();
        _source.Dispose();
    }

    private sealed class Handler(string type, Func<JsonObject, CancellationToken, Task<QueryAnswer>> run) : IQueryHandler
    {
        public string QueryType => type;
        public Task<QueryAnswer> ExecuteAsync(JsonObject parameters, CancellationToken ct) => run(parameters, ct);
    }
}
