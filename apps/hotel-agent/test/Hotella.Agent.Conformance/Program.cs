using System.Text.Json.Nodes;
using Hotella.Agent.Core.Link;
using Hotella.Agent.Core.Queue;
using Hotella.Agent.Core.Security;
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
                client ??= new LinkClient(identity!, queue,
                    new LinkOptions(gateway!, request["connector"]!.GetValue<string>(),
                        request["capabilities"]!.AsArray().Select(c => c!.GetValue<string>()).ToList(), "conformance"),
                    request["commands"]!.AsArray().Select(c => (ICommandHandler)new ReportingHandler(c!.GetValue<string>(), Write)),
                    log);
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
            case "chaos":
                if (request["reorder_next"]?.GetValue<bool>() == true) client!.Chaos.ReorderNext = true;
                if (request["duplicate_next"]?.GetValue<bool>() == true) client!.Chaos.DuplicateNext = true;
                if (request["drop_connection"]?.GetValue<bool>() == true) client!.DropConnection();
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
                if (client is not null)
                    reply["stats"] = new JsonObject
                    {
                        ["connects"] = client.Stats.Connects,
                        ["welcomes"] = client.Stats.Welcomes,
                        ["acks"] = client.Stats.Acks,
                        ["resends"] = client.Stats.Resends,
                        ["commands"] = client.Stats.Commands,
                        ["rejected_commands"] = client.Stats.RejectedCommands,
                    };
                break;
            case "quit":
                await StopAsync();
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
await StopAsync();
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
