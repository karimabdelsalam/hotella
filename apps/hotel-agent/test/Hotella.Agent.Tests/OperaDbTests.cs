using System.Reflection;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Hotella.Agent.Core.Link;
using Hotella.Agent.Core.Queue;
using Hotella.Agent.OperaDb;
using Microsoft.Extensions.Logging.Abstractions;

namespace Hotella.Agent.Tests;

public partial class OperaDbTests : IDisposable
{
    private readonly string _dir = Directory.CreateTempSubdirectory("opera-db-").FullName;
    private static readonly OperaDbSettings Settings = new()
    {
        Provider = "fixture",
        SchemaOwner = "OPERA",
        ResortCode = "SIM",
        ChangePolling = true,
        WindowDays = 14,
    };

    private static readonly (string, string, string)[] ReadOnlyGrants =
        DataContract.Objects.Select(o => ("OPERA", o, "SELECT")).ToArray();

    [GeneratedRegex(@"\b(INSERT|UPDATE|DELETE|MERGE|DROP|ALTER|CREATE|GRANT|REVOKE|EXECUTE|EXEC|BEGIN|CALL|LOCK|TRUNCATE|COMMIT|DBMS_\w+|UTL_\w+)\b|FOR\s+UPDATE", RegexOptions.IgnoreCase)]
    private static partial Regex Forbidden();

    [Fact]
    public void Every_statement_is_a_capped_resort_filtered_select_with_bind_variables()
    {
        Assert.NotEmpty(DataContract.All);
        foreach (var statement in DataContract.All)
        {
            var sql = statement.Sql("OPERA");
            Assert.StartsWith("SELECT", sql.TrimStart(), StringComparison.Ordinal);
            Assert.Contains(":resort", sql, StringComparison.Ordinal);
            Assert.Contains("FETCH FIRST :max_rows ROWS ONLY", sql, StringComparison.Ordinal);
            Assert.DoesNotMatch(Forbidden(), sql);
            Assert.DoesNotContain(";", sql, StringComparison.Ordinal);
            foreach (var bind in statement.Binds) Assert.Contains(":" + bind, sql, StringComparison.Ordinal);
        }
    }

    [Fact]
    public void There_is_no_way_to_hand_the_data_source_other_sql()
    {
        // Statements exist only as DataContract members: no public constructor, no public factory.
        Assert.Empty(typeof(ContractStatement).GetConstructors(BindingFlags.Public | BindingFlags.Instance));
        Assert.DoesNotContain(typeof(ContractStatement).GetMethods(BindingFlags.Public | BindingFlags.Static),
            m => m.ReturnType == typeof(ContractStatement));
        Assert.All(typeof(IOperaDataSource).GetMethods(),
            m => Assert.DoesNotContain(m.GetParameters(), p => p.ParameterType == typeof(string)));
        // The schema owner is the only identifier written into SQL, and it is checked.
        Assert.Throws<InvalidOperationException>(() => DataContract.InHouse.Sql("OPERA; DROP TABLE NAME"));
        Assert.Throws<InvalidOperationException>(() => DataContract.InHouse.Sql("opera"));
    }

    [Fact]
    public void Only_create_session_and_select_on_the_contract_pass_the_privilege_check()
    {
        Assert.Empty(PrivilegeCheck.Problems(new(["CREATE SESSION"], ReadOnlyGrants, []), "OPERA"));
        Assert.Contains("INSERT on OPERA.RESERVATION_NAME is not allowed",
            PrivilegeCheck.Problems(new(["CREATE SESSION"], [.. ReadOnlyGrants, ("OPERA", "RESERVATION_NAME", "INSERT")], []), "OPERA"));
        Assert.Contains("system privilege SELECT ANY TABLE is not allowed",
            PrivilegeCheck.Problems(new(["CREATE SESSION", "SELECT ANY TABLE"], ReadOnlyGrants, []), "OPERA"));
        Assert.Contains("role DBA is not allowed",
            PrivilegeCheck.Problems(new(["CREATE SESSION"], ReadOnlyGrants, ["DBA"]), "OPERA"));
        Assert.Contains("SELECT on OPERA.FINANCIAL_TRANSACTIONS is outside the data contract",
            PrivilegeCheck.Problems(new(["CREATE SESSION"], [.. ReadOnlyGrants, ("OPERA", "FINANCIAL_TRANSACTIONS", "SELECT")], []), "OPERA"));
        Assert.Contains("SELECT on OTHER.ROOM is outside the data contract",
            PrivilegeCheck.Problems(new(["CREATE SESSION"], [("OTHER", "ROOM", "SELECT")], []), "OPERA"));
        Assert.Contains("missing CREATE SESSION", PrivilegeCheck.Problems(new([], ReadOnlyGrants, []), "OPERA"));
    }

    [Fact]
    public void Maps_opera_rows_to_canonical_rows_and_never_guesses_a_status()
    {
        var row = Row(("RESV_NAME_ID", "R1"), ("CONFIRMATION_NO", "C1"), ("RESV_STATUS", "DUE OUT"),
            ("ARRIVAL_DATE", new DateTime(2026, 10, 5)), ("DEPARTURE_DATE", "2026-10-08"), ("ETA", "1430"),
            ("ADULTS", 2m), ("CHILDREN", null), ("ROOM", "504"), ("NAME_ID", 1001L));
        var r = RowMapper.Reservation(row);
        Assert.Equal("IN_HOUSE", r["status"]!.GetValue<string>());
        Assert.Equal("2026-10-05", r["arrival_date"]!.GetValue<string>());
        Assert.Equal("14:30", r["eta"]!.GetValue<string>());
        Assert.Equal(2, r["adults"]!.GetValue<int>());
        Assert.Equal(0, r["children"]!.GetValue<int>());
        Assert.Equal("1001", r["profile_id"]!.GetValue<string>());
        Assert.Throws<FormatException>(() => RowMapper.Reservation(
            Row(("RESV_NAME_ID", "R2"), ("RESV_STATUS", "WAITLIST"), ("ARRIVAL_DATE", "2026-10-05"), ("DEPARTURE_DATE", "2026-10-06"))));
    }

    [Fact]
    public async Task Answers_the_standard_reads_from_the_data_contract()
    {
        using var adapter = Adapter(Fixture(ReadOnlyGrants));
        await adapter.CheckPrivilegesAsync(CancellationToken.None);
        Assert.True(adapter.Up);
        var reads = adapter.Queries().ToDictionary(q => q.QueryType);
        Assert.Equal(["IN_HOUSE", "LIST_ARRIVALS", "LOOKUP_PROFILE", "LOOKUP_RESERVATION", "ROOM_INVENTORY"],
            reads.Keys.Order(StringComparer.Ordinal));
        var inHouse = await reads["IN_HOUSE"].ExecuteAsync([], CancellationToken.None);
        Assert.Equal(["R1"], inHouse.Rows.Select(r => r["reservation_id"]!.GetValue<string>()));
        var arrivals = await reads["LIST_ARRIVALS"].ExecuteAsync(
            new JsonObject { ["from"] = "2026-10-20", ["to"] = "2026-10-21" }, CancellationToken.None);
        Assert.Equal(["R2"], arrivals.Rows.Select(r => r["reservation_id"]!.GetValue<string>()));
        var profile = await reads["LOOKUP_PROFILE"].ExecuteAsync(new JsonObject { ["profile_id"] = "P1" }, CancellationToken.None);
        Assert.Equal("Nour", profile.Rows.Single()["first_name"]!.GetValue<string>());
        var byConfirmation = await reads["LOOKUP_RESERVATION"].ExecuteAsync(
            new JsonObject { ["confirmation_number"] = "C2" }, CancellationToken.None);
        Assert.Equal("RESERVED", byConfirmation.Rows.Single()["status"]!.GetValue<string>());
        var rooms = await reads["ROOM_INVENTORY"].ExecuteAsync([], CancellationToken.None);
        Assert.Equal(["504", "505"], rooms.Rows.Select(r => r["room_number"]!.GetValue<string>()));
        await Assert.ThrowsAsync<FormatException>(() => reads["LIST_ARRIVALS"].ExecuteAsync(
            new JsonObject { ["from"] = "tomorrow", ["to"] = "2026-10-21" }, CancellationToken.None));
    }

    [Fact]
    public async Task A_writable_account_is_refused_every_read_and_reported_unhealthy()
    {
        using var adapter = Adapter(Fixture([.. ReadOnlyGrants, ("OPERA", "RESERVATION_NAME", "UPDATE")]));
        var problems = await adapter.CheckPrivilegesAsync(CancellationToken.None);
        Assert.Equal(["UPDATE on OPERA.RESERVATION_NAME is not allowed"], problems);
        Assert.False(adapter.Up);
        Assert.Contains("more than read access", adapter.Problem, StringComparison.Ordinal);
        foreach (var read in adapter.Queries())
            await Assert.ThrowsAsync<QueryRefusedException>(() => read.ExecuteAsync(
                new JsonObject { ["from"] = "2026-10-20", ["to"] = "2026-10-21", ["profile_id"] = "P1", ["reservation_id"] = "R1" },
                CancellationToken.None));
        await Assert.ThrowsAsync<QueryRefusedException>(() => adapter.PollOnceAsync(new Collector(), CancellationToken.None));
    }

    [Fact]
    public async Task Refuses_reads_before_the_first_privilege_check()
    {
        using var adapter = Adapter(Fixture(ReadOnlyGrants));
        await Assert.ThrowsAsync<QueryRefusedException>(() =>
            adapter.Queries().Single(q => q.QueryType == "IN_HOUSE").ExecuteAsync([], CancellationToken.None));
    }

    [Fact]
    public async Task Change_polling_forwards_new_changed_and_cancelled_reservations_once()
    {
        var path = Fixture(ReadOnlyGrants);
        using var adapter = Adapter(path);
        await adapter.CheckPrivilegesAsync(CancellationToken.None);
        var sink = new Collector();
        Assert.Equal(2, await adapter.PollOnceAsync(sink, CancellationToken.None));
        Assert.Equal(["NEW", "NEW"], sink.Payloads.Select(p => p["action"]!.GetValue<string>()));
        var r2 = sink.Payloads.Single(p => p["reservation"]!["reservationId"]!.GetValue<string>() == "R2");
        Assert.Equal("Hassan", r2["reservation"]!["guest"]!["lastName"]!.GetValue<string>());
        Assert.Equal(0, await adapter.PollOnceAsync(sink, CancellationToken.None));
        File.WriteAllText(path, File.ReadAllText(path).Replace("\"ROOM\": null", "\"ROOM\": \"505\"", StringComparison.Ordinal));
        Assert.Equal(1, await adapter.PollOnceAsync(sink, CancellationToken.None));
        Assert.Equal("CHANGE", sink.Payloads[^1]["action"]!.GetValue<string>());
        File.WriteAllText(path, File.ReadAllText(path).Replace("\"RESERVED\"", "\"CANCELLED\"", StringComparison.Ordinal));
        Assert.Equal(1, await adapter.PollOnceAsync(sink, CancellationToken.None));
        Assert.Equal("CANCEL", sink.Payloads[^1]["action"]!.GetValue<string>());
        Assert.All(sink.Types, t => Assert.Equal(OperaDbAdapter.MessageType, t));
        Assert.Equal(sink.Ids.Count, sink.Ids.Distinct().Count());
    }

    private static OperaDbAdapter Adapter(string fixture) =>
        new(Settings, "11111111-1111-7111-8111-111111111111", new FixtureDataSource(fixture, "SIM"), ":memory:",
            NullLogger.Instance, () => new DateTimeOffset(2026, 10, 15, 9, 0, 0, TimeSpan.Zero));

    private string Fixture((string, string, string)[] grants)
    {
        var path = Path.Combine(_dir, $"opera-{Guid.NewGuid():N}.json");
        var fixture = new JsonObject
        {
            ["resort"] = "SIM",
            ["reservations"] = new JsonArray(
                Reservation("R1", "C1", "CHECKED IN", "2026-10-14", "2026-10-17", "504", "P1"),
                Reservation("R2", "C2", "RESERVED", "2026-10-20", "2026-10-22", null, "P2")),
            ["names"] = new JsonArray(
                new JsonObject { ["NAME_ID"] = "P1", ["FIRST"] = "Nour", ["LAST"] = "Adel", ["LANGUAGE"] = "AR" },
                new JsonObject { ["NAME_ID"] = "P2", ["FIRST"] = "Omar", ["LAST"] = "Hassan" }),
            ["rooms"] = new JsonArray(
                new JsonObject { ["ROOM"] = "505", ["ROOM_CATEGORY"] = "DLX", ["FLOOR"] = "5" },
                new JsonObject { ["ROOM"] = "504", ["ROOM_CATEGORY"] = "DLX", ["FLOOR"] = "5" }),
            ["privileges"] = new JsonObject
            {
                ["system"] = new JsonArray("CREATE SESSION"),
                ["tables"] = new JsonArray(grants.Select(g => (JsonNode)new JsonObject
                {
                    ["owner"] = g.Item1, ["table"] = g.Item2, ["privilege"] = g.Item3,
                }).ToArray()),
                ["roles"] = new JsonArray(),
            },
        };
        File.WriteAllText(path, fixture.ToJsonString(new System.Text.Json.JsonSerializerOptions { WriteIndented = true }));
        return path;
    }

    private static JsonObject Reservation(
        string id, string confirmation, string status, string arrival, string departure, string? room, string nameId) => new()
    {
        ["RESV_NAME_ID"] = id,
        ["CONFIRMATION_NO"] = confirmation,
        ["RESV_STATUS"] = status,
        ["ARRIVAL_DATE"] = arrival,
        ["DEPARTURE_DATE"] = departure,
        ["ETA"] = null,
        ["ADULTS"] = 1,
        ["CHILDREN"] = 0,
        ["ROOM"] = room,
        ["ROOM_CATEGORY"] = "DLX",
        ["RATE_CODE"] = "BAR",
        ["MARKET_CODE"] = null,
        ["NAME_ID"] = nameId,
        ["SHARE_OF"] = null,
    };

    private static DbRow Row(params (string, object?)[] values) =>
        new(values.ToDictionary(v => v.Item1, v => v.Item2, StringComparer.Ordinal));

    public void Dispose()
    {
        Directory.Delete(_dir, recursive: true);
        GC.SuppressFinalize(this);
    }

    private sealed class Collector : IMessagePublisher
    {
        public List<JsonObject> Payloads { get; } = [];
        public List<string> Ids { get; } = [];
        public List<string> Types { get; } = [];

        public QueuedMessage Publish(string sourceMessageId, string messageType, string? occurredAt, string payloadJson)
        {
            Ids.Add(sourceMessageId);
            Types.Add(messageType);
            Payloads.Add(JsonNode.Parse(payloadJson)!.AsObject());
            return new QueuedMessage(Ids.Count, sourceMessageId, messageType, occurredAt, payloadJson);
        }
    }
}
