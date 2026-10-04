namespace Hotella.Agent.OperaDb;

/// <summary>One result row: column alias → value (string, number, date or null).</summary>
public sealed class DbRow(IReadOnlyDictionary<string, object?> values)
{
    public object? this[string column] => values.TryGetValue(column, out var v) ? v : null;
    public IEnumerable<string> Columns => values.Keys;
}

public sealed record DbRows(IReadOnlyList<DbRow> Rows, bool Truncated);

/// <summary>What the account may do, as Oracle reports it to the account itself.</summary>
public sealed record PrivilegeSnapshot(
    IReadOnlyList<string> SystemPrivileges,
    IReadOnlyList<(string Owner, string Table, string Privilege)> TablePrivileges,
    IReadOnlyList<string> Roles);

/// <summary>Contract objects and columns found (or missing) in the hotel's schema, and row counts — no personal data.</summary>
public sealed record ProbeReport(
    IReadOnlyList<string> MissingObjects,
    IReadOnlyList<string> MissingColumns,
    IReadOnlyDictionary<string, long> Counts);

/// <summary>
/// Where contract statements run: the hotel's Oracle database, or a JSON fixture shaped like it (development and CI).
/// It accepts only <see cref="ContractStatement"/>s — there is no method that takes SQL text.
/// </summary>
public interface IOperaDataSource : IDisposable
{
    Task<DbRows> QueryAsync(
        ContractStatement statement, IReadOnlyDictionary<string, object?> binds, int maxRows, CancellationToken ct);

    Task<PrivilegeSnapshot> PrivilegesAsync(CancellationToken ct);

    Task<ProbeReport> ProbeAsync(CancellationToken ct);
}
