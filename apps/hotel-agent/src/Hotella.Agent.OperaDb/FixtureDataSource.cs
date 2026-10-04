using System.Globalization;
using System.Text.Json.Nodes;

namespace Hotella.Agent.OperaDb;

/// <summary>
/// A JSON file shaped like the contract's result columns, standing in for the OPERA database in development and CI
/// (CI does not run Oracle; guide §17). The simulator writes it from its hotel; each statement is evaluated by its id
/// with the same filters the SQL applies, so the adapter, the row mapper and the platform see exactly what they would
/// see from OPERA. Re-read on every call, so a test can change the hotel while the agent runs.
/// <code>
/// { "resort": "SIM", "reservations": [ { "RESV_NAME_ID": "…", "RESV_STATUS": "CHECKED IN", … } ],
///   "names": [ { "NAME_ID": "…", "FIRST": "…", … } ], "rooms": [ { "ROOM": "504", … } ],
///   "privileges": { "system": ["CREATE SESSION"], "tables": [ { "owner": "OPERA", "table": "ROOM",
///   "privilege": "SELECT" } ], "roles": [] } }
/// </code>
/// </summary>
public sealed class FixtureDataSource(string path, string resort) : IOperaDataSource
{
    public async Task<DbRows> QueryAsync(
        ContractStatement statement, IReadOnlyDictionary<string, object?> binds, int maxRows, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(statement);
        ArgumentNullException.ThrowIfNull(binds);
        var fixture = await LoadAsync(ct).ConfigureAwait(false);
        if (!string.Equals(fixture["resort"]?.GetValue<string>(), resort, StringComparison.Ordinal))
            return new DbRows([], false);
        var reservations = Rows(fixture, "reservations");
        string? Bind(string name) => !binds.TryGetValue(name, out var v) ? null
            : v is DateOnly d ? DataContract.Date(d)
            : Convert.ToString(v, CultureInfo.InvariantCulture);
        bool Status(DbRow r, params string[] statuses) => statuses.Contains(r["RESV_STATUS"] as string);
        var known = DataContract.Statuses.Keys.ToArray();
        IEnumerable<DbRow> result = statement.Id switch
        {
            "RESERVATION_BY_ID" => reservations.Where(r => Equals(r["RESV_NAME_ID"], Bind("reservation_id")) && Status(r, known)),
            "RESERVATION_BY_CONFIRMATION" => reservations.Where(r => Equals(r["CONFIRMATION_NO"], Bind("confirmation_number")) && Status(r, known)),
            "ARRIVALS" => reservations
                .Where(r => Between(r["ARRIVAL_DATE"], Bind("from_date"), Bind("to_date")) && Status(r, "RESERVED", "DUE IN", "CHECKED IN"))
                .OrderBy(r => r["ARRIVAL_DATE"] as string, StringComparer.Ordinal)
                .ThenBy(r => r["RESV_NAME_ID"] as string, StringComparer.Ordinal),
            "IN_HOUSE" => reservations.Where(r => Status(r, "CHECKED IN", "DUE OUT"))
                .OrderBy(r => r["RESV_NAME_ID"] as string, StringComparer.Ordinal),
            "PROFILE" => Rows(fixture, "names").Where(n => Equals(n["NAME_ID"], Bind("name_id"))
                && reservations.Any(r => Equals(r["NAME_ID"], n["NAME_ID"]))),
            "ROOMS" => Rows(fixture, "rooms").OrderBy(r => r["ROOM"] as string, StringComparer.Ordinal),
            "ARRIVALS_WITH_GUEST" => reservations
                .Where(r => Between(r["ARRIVAL_DATE"], Bind("from_date"), Bind("to_date"))
                    && Status(r, "RESERVED", "DUE IN", "CHECKED IN", "CANCELLED", "NO SHOW"))
                .Select(r => WithGuest(r, Rows(fixture, "names").FirstOrDefault(n => Equals(n["NAME_ID"], r["NAME_ID"]))))
                .OrderBy(r => r["ARRIVAL_DATE"] as string, StringComparer.Ordinal)
                .ThenBy(r => r["RESV_NAME_ID"] as string, StringComparer.Ordinal),
            _ => throw new InvalidOperationException($"statement {statement.Id} is not in the fixture"),
        };
        var list = result.Take(maxRows + 1).ToList();
        return new DbRows(list.Take(maxRows).ToList(), list.Count > maxRows);
    }

    public async Task<PrivilegeSnapshot> PrivilegesAsync(CancellationToken ct)
    {
        var p = (await LoadAsync(ct).ConfigureAwait(false))["privileges"] as JsonObject ?? [];
        static List<string> Strings(JsonNode? n) => (n as JsonArray ?? []).Select(x => x!.GetValue<string>()).ToList();
        return new PrivilegeSnapshot(
            Strings(p["system"]),
            (p["tables"] as JsonArray ?? []).Select(t => (
                t!["owner"]!.GetValue<string>(), t["table"]!.GetValue<string>(), t["privilege"]!.GetValue<string>())).ToList(),
            Strings(p["roles"]));
    }

    public async Task<ProbeReport> ProbeAsync(CancellationToken ct)
    {
        var fixture = await LoadAsync(ct).ConfigureAwait(false);
        return new ProbeReport([], [], new Dictionary<string, long>(StringComparer.Ordinal)
        {
            ["RESERVATION_NAME"] = Rows(fixture, "reservations").Count,
            ["ROOM"] = Rows(fixture, "rooms").Count,
        });
    }

    private async Task<JsonObject> LoadAsync(CancellationToken ct) =>
        JsonNode.Parse(await File.ReadAllTextAsync(path, ct).ConfigureAwait(false)) as JsonObject
            ?? throw new InvalidOperationException("the OPERA fixture is not a JSON object");

    private static List<DbRow> Rows(JsonObject fixture, string table) =>
        (fixture[table] as JsonArray ?? []).Select(r => new DbRow(((JsonObject)r!).ToDictionary(
            kv => kv.Key, kv => Value(kv.Value), StringComparer.Ordinal))).ToList();

    private static object? Value(JsonNode? n) => n switch
    {
        null => null,
        JsonValue v when v.TryGetValue<string>(out var s) => s,
        JsonValue v when v.TryGetValue<long>(out var l) => l,
        JsonValue v when v.TryGetValue<decimal>(out var d) => d,
        _ => n.ToJsonString(),
    };

    private static bool Between(object? day, string? from, string? to) =>
        day is string d && from is not null && to is not null
        && string.CompareOrdinal(d, from) >= 0 && string.CompareOrdinal(d, to) <= 0;

    private static DbRow WithGuest(DbRow reservation, DbRow? name)
    {
        var values = reservation.Columns.ToDictionary(c => c, c => reservation[c], StringComparer.Ordinal);
        foreach (var column in new[] { "TITLE", "FIRST", "LAST", "LANGUAGE", "VIP_STATUS" })
            values[column] = name?[column];
        return new DbRow(values);
    }

    public void Dispose()
    {
    }
}
