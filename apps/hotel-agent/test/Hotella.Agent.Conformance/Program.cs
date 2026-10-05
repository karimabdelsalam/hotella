using System.Text.Json.Nodes;
using Hotella.Agent.Core.Connectors;
using Hotella.Agent.Core.Licensing;
using Hotella.Agent.Core.Link;
using Hotella.Agent.Core.Queue;
using Hotella.Agent.Core.Security;
using Hotella.Agent.Fias;
using Hotella.Agent.OperaDb;
using Hotella.Agent.Ows;
using Microsoft.Extensions.Logging;

// The agent under test, remote-controlled line by line. Answers carry the request's "id"; commands the platform sends
// are reported as {"event":"command",...} lines so the test's simulated PMS can react (e.g. RESYNC_IN_HOUSE).
// Logs go to stderr: stdout carries the protocol.
using var loggers = LoggerFactory.Create(b => b
    .SetMinimumLevel(LogLevel.Information)
    .AddConsole(o => o.LogToStandardErrorThreshold = LogLevel.Trace));
var log = loggers.CreateLogger("conformance");
var output = Console.Out;
var writeLock = new Lock();
void Write(JsonObject line)
{
    lock (writeLock)
    {
        output.WriteLine(line.ToJsonString());
        output.Flush();
    }
}

AgentIdentity? identity = null;
Uri? gateway = null;
using var queue = DurableOutbox.Open(":memory:");
LinkClient? client = null;
CancellationTokenSource? running = null;
Task? run = null;
FiasAdapter? fias = null;
LicenceStore? licences = null;
var licenceClockDays = 0;
var licenceDir = Directory.CreateTempSubdirectory("hotella-conformance-").FullName;
OwsAdapter? ows = null;
OperaDbAdapter? operaDb = null;
using var adapterStop = new CancellationTokenSource();
Task? adapterRun = null;

async Task QuitAsync()
{
    await StopAsync();
    if (adapterRun is not null)
    {
        await adapterStop.CancelAsync();
        await adapterRun;
    }
    fias?.Dispose();
    ows?.Dispose();
    operaDb?.Dispose();
    Directory.Delete(licenceDir, recursive: true);
}

async Task StopAsync()
{
    if (running is null) return;
    await running.CancelAsync();
    await run!;
    running.Dispose();
    running = null;
}

while (Console.ReadLine() is { } text)
{
    if (string.IsNullOrWhiteSpace(text)) continue;
    var request = JsonNode.Parse(text)!.AsObject();
    var reply = new JsonObject { ["id"] = request["id"]?.DeepClone(), ["ok"] = true };
    try
    {
        switch (request["op"]!.GetValue<string>())
        {
            case "enroll":
                gateway = new Uri(request["gateway"]!.GetValue<string>());
                identity = await Enrollment.EnrollAsync(gateway, request["token"]!.GetValue<string>(),
                    request["ca"]!.GetValue<string>(), "conformance", CancellationToken.None);
                reply["instance_id"] = identity.InstanceId;
                break;
            case "renew":
                identity = await Enrollment.RenewAsync(gateway!, identity!, CancellationToken.None);
                client?.UseIdentity(identity);
                reply["certificate"] = identity.CertificatePem;
                break;
            case "start":
                if (client is null && request["ifc8"] is JsonObject ifc8)
                {
                    // OPERA5_FIAS: the IFC8 session publishes into the link and serves its commands.
                    fias = new FiasAdapter(new FiasSettings
                    {
                        Host = ifc8["host"]!.GetValue<string>(),
                        Port = ifc8["port"]!.GetValue<int>(),
                        ReconnectSeconds = 1,
                        LinkAliveSeconds = 5,
                    }, identity!.InstanceId, log);
                }
                if (client is null && request["ows"] is JsonObject owsRequest)
                {
                    // OPERA5_OWS: the poller publishes into the link; the standard reads and the contact write.
                    var password = owsRequest["password"]!.GetValue<string>();
                    ows = new OwsAdapter(new OwsSettings
                    {
                        Url = new Uri(owsRequest["url"]!.GetValue<string>()),
                        Username = owsRequest["user"]!.GetValue<string>(),
                        HotelCode = "SIM",
                        PollSeconds = owsRequest["poll_seconds"]?.GetValue<int>() ?? 1,
                    }, identity!.InstanceId, () => password, ":memory:", log);
                }
                if (client is null && request["opera_db"] is JsonObject dbRequest)
                {
                    // OPERA5_DB: predefined reads over link protocol 2 from the simulator's OPERA-shaped fixture.
                    var settings = new OperaDbSettings
                    {
                        Provider = "fixture",
                        FixturePath = dbRequest["fixture"]!.GetValue<string>(),
                        ResortCode = dbRequest["resort"]!.GetValue<string>(),
                        ChangePolling = dbRequest["change_polling"]?.GetValue<bool>() ?? false,
                        PollSeconds = 60,
                    };
                    operaDb = new OperaDbAdapter(settings, identity!.InstanceId,
                        new FixtureDataSource(settings.FixturePath, settings.ResortCode), ":memory:", log);
                    await operaDb.CheckPrivilegesAsync(CancellationToken.None);
                }
                // Connector SDK v2: whichever adapter was asked for, the link sees only IConnectorAdapter.
                IConnectorAdapter? adapter = (IConnectorAdapter?)fias ?? (IConnectorAdapter?)ows ?? operaDb;
                client ??= new LinkClient(identity!, queue,
                    new LinkOptions(gateway!, request["connector"]!.GetValue<string>(),
                        request["capabilities"]!.AsArray().Select(c => c!.GetValue<string>()).ToList(), "conformance"),
                    adapter?.Commands() ?? request["commands"]!.AsArray()
                        .Select(c => (ICommandHandler)new ReportingHandler(c!.GetValue<string>(), Write)),
                    log, adapter?.Queries());
                if (licences is null)
                {
                    licences = new LicenceStore(licenceDir, new CommandSignature(identity!.CommandPublicKeyPem),
                        identity.InstanceId);
                    var store = licences;
                    client.LicenceOffered += token => store.Offer(token);
                    client.CommandGate = () => store.CommandRefusal(DateTimeOffset.UtcNow.AddDays(licenceClockDays));
                }
                if (adapter is not null && adapterRun is null)
                {
                    var link = client;
                    adapterRun = Task.Run(() => adapter.RunAsync(link, adapterStop.Token));
                }
                if (running is null)
                {
                    running = new CancellationTokenSource();
                    var token = running.Token;
                    run = Task.Run(() => client.RunAsync(token));
                }
                break;
            case "stop":
                await StopAsync();
                break;
            case "publish":
                reply["sequence_no"] = client!.Publish(request["source_message_id"]!.GetValue<string>(),
                    request["message_type"]!.GetValue<string>(), request["occurred_at"]?.GetValue<string>(),
                    request["payload"]!.ToJsonString()).SequenceNo;
                break;
            case "opera_db_check":
                reply["problems"] = new JsonArray((await operaDb!.CheckPrivilegesAsync(CancellationToken.None))
                    .Select(p => (JsonNode)p).ToArray());
                break;
            case "opera_db_poll":
                reply["forwarded"] = await operaDb!.PollOnceAsync(client!, CancellationToken.None);
                break;
            case "chaos":
                if (request["reorder_next"]?.GetValue<bool>() == true) client!.Chaos.ReorderNext = true;
                if (request["duplicate_next"]?.GetValue<bool>() == true) client!.Chaos.DuplicateNext = true;
                if (request["drop_connection"]?.GetValue<bool>() == true) client!.DropConnection();
                break;
            case "licence_clock":
                // Days added to "now" when the licence is evaluated: simulates an agent offline past its grace.
                licenceClockDays = request["days"]!.GetValue<int>();
                break;
            case "drained":
                await client!.DrainedAsync(
                    TimeSpan.FromMilliseconds(request["timeout_ms"]?.GetValue<int>() ?? 15_000), CancellationToken.None);
                break;
            case "batch":
                var (acked, resend) = await client!.SendBatchAsync(CancellationToken.None);
                reply["acked_through"] = acked;
                reply["resend_from"] = resend;
                break;
            case "state":
                reply["connected"] = client?.Connected ?? false;
                reply["revoked"] = client?.Revoked ?? false;
                reply["queue_depth"] = queue.Depth;
                if (licences is not null)
                    reply["licence"] = new JsonObject
                    {
                        ["state"] = licences.StateAt(DateTimeOffset.UtcNow.AddDays(licenceClockDays)).ToString().ToUpperInvariant(),
                        ["expires_at"] = licences.Current?.ExpiresAt.ToString("O", System.Globalization.CultureInfo.InvariantCulture),
                        ["capabilities"] = licences.Current is { } l ? new JsonArray([.. l.Capabilities.Select(c => (JsonNode)c)]) : null,
                    };
                if (ows is not null)
                    reply["ows"] = new JsonObject
                    {
                        ["polls"] = ows.Polls,
                        ["failures"] = ows.Failures,
                        ["forwarded"] = ows.Forwarded,
                        ["last_error"] = ows.LastError,
                        ["contact_writes"] = ows.ContactWrites,
                    };
                if (operaDb is not null)
                    reply["opera_db"] = new JsonObject
                    {
                        ["up"] = operaDb.Up,
                        ["problem"] = operaDb.Problem,
                        ["polls"] = operaDb.Polls,
                        ["forwarded"] = operaDb.Forwarded,
                    };
                if (fias is not null)
                    reply["ifc8"] = new JsonObject
                    {
                        ["link_up"] = fias.LinkUp,
                        ["sessions"] = fias.Sessions,
                        ["forwarded"] = fias.Forwarded,
                    };
                if (client is not null)
                    reply["stats"] = new JsonObject
                    {
                        ["connects"] = client.Stats.Connects,
                        ["welcomes"] = client.Stats.Welcomes,
                        ["acks"] = client.Stats.Acks,
                        ["resends"] = client.Stats.Resends,
                        ["commands"] = client.Stats.Commands,
                        ["rejected_commands"] = client.Stats.RejectedCommands,
                        ["queries"] = client.Stats.Queries,
                        ["rejected_queries"] = client.Stats.RejectedQueries,
                    };
                break;
            case "quit":
                await QuitAsync();
                Write(reply);
                return 0;
            default:
                throw new InvalidOperationException("unknown op");
        }
    }
    catch (GatewayHttpException e)
    {
        reply["ok"] = false;
        reply["status"] = e.Status;
        reply["code"] = e.Code;
    }
#pragma warning disable CA1031 // Every failure is reported to the test as an answer; the process keeps serving.
    catch (Exception e)
#pragma warning restore CA1031
    {
        reply["ok"] = false;
        reply["error"] = e.Message;
    }
    Write(reply);
}
await QuitAsync();
return 0;

/// <summary>Acknowledges its command type and tells the test, which plays the PMS side of the command.</summary>
internal sealed class ReportingHandler(string commandType, Action<JsonObject> write) : ICommandHandler
{
    public string CommandType => commandType;

    public Task<CommandOutcome> ExecuteAsync(JsonNode? payload, CancellationToken ct)
    {
        write(new JsonObject { ["event"] = "command", ["command_type"] = commandType, ["payload"] = payload?.DeepClone() });
        return Task.FromResult(CommandOutcome.Ok);
    }
}
