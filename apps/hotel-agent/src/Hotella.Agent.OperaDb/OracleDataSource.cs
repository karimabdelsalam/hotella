using System.Data;
using System.Globalization;
using Oracle.ManagedDataAccess.Client;

namespace Hotella.Agent.OperaDb;

/// <summary>
/// The hotel's OPERA database through Oracle's managed driver (no client install, no native code). Defence in depth
/// (guide §6.4): only contract statements, each in a transaction opened with <c>SET TRANSACTION READ ONLY</c> and rolled
/// back afterwards; bind variables only; a statement timeout; a row cap; a pool of at most two sessions.
/// </summary>
public sealed class OracleDataSource : IOperaDataSource
{
    private static readonly string[] CountedTables = ["RESERVATION_NAME", "ROOM"];
    private readonly OperaDbSettings _settings;
    private readonly string _connectionString;

    public OracleDataSource(OperaDbSettings settings, string password)
    {
        ArgumentNullException.ThrowIfNull(settings);
        _settings = settings;
        _connectionString = new OracleConnectionStringBuilder
        {
            DataSource = $"//{settings.Host}:{settings.Port.ToString(CultureInfo.InvariantCulture)}/{settings.ServiceName}",
            UserID = settings.Username,
            Password = password,
            MaxPoolSize = 2,
            MinPoolSize = 0,
            ConnectionTimeout = 15,
            StatementCacheSize = DataContract.All.Count,
        }.ConnectionString;
    }

    public async Task<DbRows> QueryAsync(
        ContractStatement statement, IReadOnlyDictionary<string, object?> binds, int maxRows, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(statement);
        ArgumentNullException.ThrowIfNull(binds);
        var all = new Dictionary<string, object?>(binds, StringComparer.Ordinal)
        {
            ["resort"] = _settings.ResortCode,
            ["max_rows"] = maxRows + 1,
        };
        return await ReadOnlyAsync(async (connection, tx) =>
        {
            await using var command = Command(connection, tx, statement.Sql(_settings.SchemaOwner));
            foreach (var (name, value) in all)
                if (statement.Template.Contains(":" + name, StringComparison.Ordinal))
                    command.Parameters.Add(new OracleParameter(name, Bind(value)));
            var rows = new List<DbRow>();
            await using var reader = await command.ExecuteReaderAsync(ct).ConfigureAwait(false);
            while (await reader.ReadAsync(ct).ConfigureAwait(false))
            {
                if (rows.Count == maxRows) return new DbRows(rows, Truncated: true);
                rows.Add(Row(reader));
            }
            return new DbRows(rows, Truncated: false);
        }, ct).ConfigureAwait(false);
    }

    public async Task<PrivilegeSnapshot> PrivilegesAsync(CancellationToken ct) =>
        await ReadOnlyAsync(async (connection, tx) =>
        {
            var system = await Column(connection, tx, DataContract.SystemPrivileges, ct).ConfigureAwait(false);
            var roles = await Column(connection, tx, DataContract.Roles, ct).ConfigureAwait(false);
            var tables = new List<(string, string, string)>();
            await using var command = Command(connection, tx, DataContract.TablePrivileges);
            await using var reader = await command.ExecuteReaderAsync(ct).ConfigureAwait(false);
            while (await reader.ReadAsync(ct).ConfigureAwait(false))
                tables.Add((reader.GetString(0), reader.GetString(1), reader.GetString(2)));
            return new PrivilegeSnapshot(system, tables, roles);
        }, ct).ConfigureAwait(false);

    public async Task<ProbeReport> ProbeAsync(CancellationToken ct) =>
        await ReadOnlyAsync(async (connection, tx) =>
        {
            var owner = _settings.SchemaOwner;
            var present = new HashSet<string>(StringComparer.Ordinal);
            var columns = new HashSet<string>(StringComparer.Ordinal);
            await using (var command = Command(connection, tx,
                "SELECT TABLE_NAME, COLUMN_NAME FROM ALL_TAB_COLUMNS WHERE OWNER = :owner"))
            {
                command.Parameters.Add(new OracleParameter("owner", owner));
                await using var reader = await command.ExecuteReaderAsync(ct).ConfigureAwait(false);
                while (await reader.ReadAsync(ct).ConfigureAwait(false))
                {
                    present.Add(reader.GetString(0));
                    columns.Add($"{reader.GetString(0)}.{reader.GetString(1)}");
                }
            }
            var counts = new Dictionary<string, long>(StringComparer.Ordinal);
            foreach (var table in CountedTables.Where(present.Contains))
            {
                // Counts only: how much the contract will see for this resort, never a row.
                await using var count = Command(connection, tx,
                    $"SELECT COUNT(*) FROM {owner}.{table} WHERE RESORT = :resort");
                count.Parameters.Add(new OracleParameter("resort", _settings.ResortCode));
                counts[table] = Convert.ToInt64(await count.ExecuteScalarAsync(ct).ConfigureAwait(false),
                    CultureInfo.InvariantCulture);
            }
            return new ProbeReport(
                DataContract.Objects.Where(o => !present.Contains(o)).ToList(),
                ContractColumns.Required.Where(c => present.Contains(c.Split('.')[0]) && !columns.Contains(c)).ToList(),
                counts);
        }, ct).ConfigureAwait(false);

    private async Task<T> ReadOnlyAsync<T>(
        Func<OracleConnection, OracleTransaction, Task<T>> work, CancellationToken ct)
    {
        await using var connection = new OracleConnection(_connectionString);
        await connection.OpenAsync(ct).ConfigureAwait(false);
        await using var tx = connection.BeginTransaction(IsolationLevel.ReadCommitted);
        // The first statement of the transaction: Oracle then refuses any change for its whole duration.
        await using (var readOnly = Command(connection, tx, "SET TRANSACTION READ ONLY"))
            await readOnly.ExecuteNonQueryAsync(ct).ConfigureAwait(false);
        try
        {
            return await work(connection, tx).ConfigureAwait(false);
        }
        finally
        {
            await tx.RollbackAsync(CancellationToken.None).ConfigureAwait(false);
        }
    }

    private OracleCommand Command(OracleConnection connection, OracleTransaction tx, string sql)
    {
#pragma warning disable CA2100 // Only contract statements and fixed dictionary queries; values are always bound.
        var command = new OracleCommand(sql, connection)
#pragma warning restore CA2100
        {
            Transaction = tx,
            BindByName = true,
            CommandTimeout = _settings.QueryTimeoutSeconds,
            FetchSize = 256 * 1024,
        };
        return command;
    }

    private static async Task<List<string>> Column(
        OracleConnection connection, OracleTransaction tx, string sql, CancellationToken ct)
    {
#pragma warning disable CA2100 // Fixed dictionary queries of the self-check.
        await using var command = new OracleCommand(sql, connection) { Transaction = tx };
#pragma warning restore CA2100
        var values = new List<string>();
        await using var reader = await command.ExecuteReaderAsync(ct).ConfigureAwait(false);
        while (await reader.ReadAsync(ct).ConfigureAwait(false)) values.Add(reader.GetString(0));
        return values;
    }

    private static object Bind(object? value) => value switch
    {
        null => DBNull.Value,
        DateOnly d => d.ToDateTime(TimeOnly.MinValue),
        _ => value,
    };

    private static DbRow Row(OracleDataReader reader)
    {
        var values = new Dictionary<string, object?>(StringComparer.Ordinal);
        for (var i = 0; i < reader.FieldCount; i++)
            values[reader.GetName(i)] = reader.IsDBNull(i) ? null : reader.GetValue(i);
        return new DbRow(values);
    }

    public void Dispose()
    {
        // Pooled connections close with the process; nothing is held between statements.
    }
}

/// <summary>Columns of data contract v1 the probe verifies before go-live (guide §6.3 "to verify").</summary>
public static class ContractColumns
{
    public static readonly IReadOnlyList<string> Required =
    [
        "RESERVATION_NAME.RESV_NAME_ID", "RESERVATION_NAME.NAME_ID", "RESERVATION_NAME.CONFIRMATION_NO",
        "RESERVATION_NAME.RESV_STATUS", "RESERVATION_NAME.RESORT", "RESERVATION_NAME.TRUNC_BEGIN_DATE",
        "RESERVATION_NAME.TRUNC_END_DATE", "RESERVATION_NAME.ARRIVAL_ESTIMATE_TIME",
        "RESERVATION_NAME.PARENT_RESV_NAME_ID",
        "RESERVATION_DAILY_ELEMENT_NAME.RESV_NAME_ID", "RESERVATION_DAILY_ELEMENT_NAME.RESERVATION_DATE",
        "RESERVATION_DAILY_ELEMENT_NAME.RESV_DAILY_EL_SEQ", "RESERVATION_DAILY_ELEMENT_NAME.ADULTS",
        "RESERVATION_DAILY_ELEMENT_NAME.CHILDREN", "RESERVATION_DAILY_ELEMENT_NAME.RATE_CODE",
        "RESERVATION_DAILY_ELEMENTS.RESV_DAILY_EL_SEQ", "RESERVATION_DAILY_ELEMENTS.ROOM",
        "RESERVATION_DAILY_ELEMENTS.ROOM_CATEGORY", "RESERVATION_DAILY_ELEMENTS.MARKET_CODE",
        "NAME.NAME_ID", "NAME.TITLE", "NAME.FIRST", "NAME.LAST", "NAME.LANGUAGE", "NAME.VIP_STATUS",
        "NAME_PHONE.NAME_ID", "NAME_PHONE.PHONE_ROLE", "NAME_PHONE.PHONE_NUMBER", "NAME_PHONE.PRIMARY_YN",
        "ROOM.ROOM", "ROOM.RESORT", "ROOM.ROOM_CATEGORY", "ROOM.FLOOR",
    ];
}
