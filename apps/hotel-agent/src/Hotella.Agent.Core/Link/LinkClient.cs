using System.Globalization;
using System.Net;
using System.Net.Http.Json;
using System.Net.WebSockets;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Hotella.Agent.Core.Queue;
using Hotella.Agent.Core.Security;
using Microsoft.Extensions.Logging;

namespace Hotella.Agent.Core.Link;

/// <summary>What a command handler answers (the link reports it as <c>command_result</c>).</summary>
public sealed record CommandOutcome(bool Acknowledged, string? Error)
{
    public static readonly CommandOutcome Ok = new(true, null);
    public static CommandOutcome Failed(string error) => new(false, error);
}

/// <summary>An adapter's handler for one predefined command type of the connector manifest (no generic shell).</summary>
public interface ICommandHandler
{
    string CommandType { get; }
    Task<CommandOutcome> ExecuteAsync(JsonNode? payload, CancellationToken ct);
}

public sealed record LinkOptions(
    Uri Gateway,
    string ConnectorCode,
    IReadOnlyList<string> Capabilities,
    string AgentVersion)
{
    public const int ProtocolVersion = 1;
    public const string LinkPath = "/agent/v1/link";
    public const string BatchPath = "/agent/v1/batches";
    public TimeSpan MaxBackoff { get; init; } = TimeSpan.FromSeconds(60);
}

/// <summary>Counters for health reporting and the conformance tests.</summary>
public sealed class LinkStats
{
    private int _connects, _welcomes, _acks, _resends, _commands, _rejectedCommands, _throttles;
    public int Connects => _connects;
    public int Welcomes => _welcomes;
    public int Acks => _acks;
    public int Resends => _resends;
    public int Commands => _commands;
    public int RejectedCommands => _rejectedCommands;
    public int Throttles => _throttles;
    internal void Connected() => Interlocked.Increment(ref _connects);
    internal void Welcomed() => Interlocked.Increment(ref _welcomes);
    internal void Acked() => Interlocked.Increment(ref _acks);
    internal void Resent() => Interlocked.Increment(ref _resends);
    internal void Executed() => Interlocked.Increment(ref _commands);
    internal void Rejected() => Interlocked.Increment(ref _rejectedCommands);
    internal void Throttled() => Interlocked.Increment(ref _throttles);
}

/// <summary>Fault injection for the cross-language conformance test only (mirrors the reference agent's chaos).</summary>
public sealed class LinkChaos
{
    public bool ReorderNext { get; set; }
    public bool DuplicateNext { get; set; }
}

/// <summary>
/// The agent side of the link (ADR-0017 §3–§4), a second implementation of the protocol whose executable specification
/// is <c>apps/pms-simulator</c>: outbound-only WSS with the device certificate; <c>hello</c> → <c>welcome</c>; ordered
/// sending from the durable queue; cumulative acks; resend on request; heartbeats with the queue depth; throttle;
/// signed-command verification against the pinned key with idempotent execution; HTTPS batches; reconnect with
/// exponential back-off and jitter (1 s → 60 s). A 401 or close code 4401 means the certificate was revoked: the link
/// stops and the agent needs a new enrollment.
/// </summary>
public sealed class LinkClient : IAsyncDisposable
{
    private static readonly JsonSerializerOptions Json = new() { WriteIndented = false };
    private AgentIdentity _identity;
    private readonly DurableOutbox _queue;
    private readonly LinkOptions _options;
    private readonly ILogger _log;
    private readonly CommandSignature _signature;
    private readonly Dictionary<string, ICommandHandler> _handlers;
    private readonly SemaphoreSlim _sendLock = new(1, 1);
    private readonly SemaphoreSlim _flushSignal = new(0, int.MaxValue);
    private readonly Lock _state = new();
    private ClientWebSocket? _ws;
    private bool _welcomed;
    private long _lastSent;
    private int _attempt;
    private int _maxPerSecond;
    private long? _rewindTo;
    private QueuedMessage? _held;
    private const int PageSize = 500;
    private int _draining;

    public LinkClient(
        AgentIdentity identity,
        DurableOutbox queue,
        LinkOptions options,
        IEnumerable<ICommandHandler> handlers,
        ILogger logger)
    {
        _identity = identity;
        _queue = queue;
        _options = options;
        _log = logger;
        _signature = new CommandSignature(identity.CommandPublicKeyPem);
        _handlers = handlers.ToDictionary(h => h.CommandType, StringComparer.Ordinal);
    }

    public LinkStats Stats { get; } = new();
    public LinkChaos Chaos { get; } = new();
    public bool Revoked { get; private set; }
    public bool Connected { get { lock (_state) return _welcomed && _ws?.State == WebSocketState.Open; } }
    public DateTimeOffset? LastWelcome { get; private set; }

    /// <summary>Raised after each welcome (conformance and health).</summary>
    public event Action? Welcomed;

    /// <summary>Durably queues a vendor message and wakes the sender; it goes out when the link is up.</summary>
    public QueuedMessage Publish(string sourceMessageId, string messageType, string? occurredAt, string payloadJson)
    {
        var m = _queue.Append(sourceMessageId, messageType, occurredAt, payloadJson);
        _flushSignal.Release();
        return m;
    }

    /// <summary>Runs until cancelled or revoked: connect, serve, and reconnect with back-off.</summary>
    public async Task RunAsync(CancellationToken ct)
    {
        while (!ct.IsCancellationRequested && !Revoked)
        {
            try
            {
                await ServeOnceAsync(ct).ConfigureAwait(false);
            }
            catch (OperationCanceledException) when (ct.IsCancellationRequested)
            {
                break;
            }
#pragma warning disable CA1031 // Whatever ends a session, the agent reconnects: it must never stop silently.
            catch (Exception e)
#pragma warning restore CA1031
            {
                _log.LogWarning("link down: {Kind}: {Reason}", e.GetType().Name, e.Message);
            }
            if (Revoked || ct.IsCancellationRequested) break;
            var delay = Backoff();
            _log.LogInformation("reconnecting in {Delay} ms", (int)delay.TotalMilliseconds);
            try
            {
                await Task.Delay(delay, ct).ConfigureAwait(false);
            }
            catch (OperationCanceledException)
            {
                break;
            }
        }
    }

    /// <summary>
    /// Uses a renewed certificate from now on (next connection and batch); the session in progress keeps its TLS
    /// session until it ends.
    /// </summary>
    public void UseIdentity(AgentIdentity renewed)
    {
        ArgumentNullException.ThrowIfNull(renewed);
        if (renewed.InstanceId != _identity.InstanceId)
            throw new ArgumentException("a renewed identity belongs to the same instance", nameof(renewed));
        Volatile.Write(ref _identity, renewed);
    }

    /// <summary>Waits until every queued message is acknowledged (a message held by the reorder chaos goes out now).</summary>
    public async Task DrainedAsync(TimeSpan timeout, CancellationToken ct)
    {
        Interlocked.Increment(ref _draining);
        try
        {
            var deadline = DateTimeOffset.UtcNow + timeout;
            while (_queue.Depth > 0)
            {
                if (Revoked) throw new InvalidOperationException("link revoked");
                if (DateTimeOffset.UtcNow > deadline)
                    throw new TimeoutException($"link not drained: {_queue.Depth} message(s) unacknowledged");
                if (_held is not null) _flushSignal.Release();
                await Task.Delay(25, ct).ConfigureAwait(false);
            }
        }
        finally
        {
            Interlocked.Decrement(ref _draining);
        }
    }

    /// <summary>Cuts the connection like a network failure; <see cref="RunAsync"/> reconnects.</summary>
    public void DropConnection()
    {
        lock (_state) _ws?.Abort();
    }

    /// <summary>HTTPS batch upload (large resyncs) of what is queued; the socket is not needed.</summary>
    public async Task<(long ackedThrough, long? resendFrom)> SendBatchAsync(CancellationToken ct)
    {
        var messages = new JsonArray();
        foreach (var m in _queue.Pending()) messages.Add(MessageFrame(m));
        using var http = new HttpClient(AgentTls.CreateHandler(_identity.CaCertificatePem, _identity))
        {
            BaseAddress = _options.Gateway,
        };
        using var content = new StringContent(
            new JsonObject { ["messages"] = messages }.ToJsonString(), Encoding.UTF8, "application/json");
        using var res = await http.PostAsync(LinkOptions.BatchPath, content, ct).ConfigureAwait(false);
        await LinkHttp.EnsureSuccessAsync(res, ct).ConfigureAwait(false);
        var body = await res.Content.ReadFromJsonAsync<JsonObject>(ct).ConfigureAwait(false)
            ?? throw new InvalidDataException("empty batch response");
        var acked = body["acked_through"]!.GetValue<long>();
        _queue.AckThrough(acked);
        var resend = body["resend_from"] is JsonValue r ? r.GetValue<long>() : (long?)null;
        return (acked, resend);
    }

    public async ValueTask DisposeAsync()
    {
        ClientWebSocket? ws;
        lock (_state) ws = _ws;
        if (ws is { State: WebSocketState.Open })
        {
            try
            {
                using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(2));
                await ws.CloseAsync(WebSocketCloseStatus.NormalClosure, "agent stopping", cts.Token).ConfigureAwait(false);
            }
            catch (Exception e) when (e is WebSocketException or OperationCanceledException)
            {
                // Closing best-effort.
            }
        }
        ws?.Dispose();
        _sendLock.Dispose();
        _flushSignal.Dispose();
    }

    // ---- one session ----

    private async Task ServeOnceAsync(CancellationToken ct)
    {
        var ws = new ClientWebSocket();
        ws.Options.CollectHttpResponseDetails = true;
        ws.Options.KeepAliveInterval = TimeSpan.FromSeconds(20);
        using var invoker = new HttpMessageInvoker(AgentTls.CreateHandler(_identity.CaCertificatePem, _identity));
        var url = new UriBuilder(new Uri(_options.Gateway, LinkOptions.LinkPath))
        {
            Scheme = _options.Gateway.Scheme == "http" ? "ws" : "wss",
        }.Uri;
        lock (_state)
        {
            _ws = ws;
            _welcomed = false;
        }
        try
        {
            await ws.ConnectAsync(url, invoker, ct).ConfigureAwait(false);
        }
        catch (WebSocketException) when (ws.HttpStatusCode == HttpStatusCode.Unauthorized)
        {
            MarkRevoked("certificate refused (HTTP 401)");
            return;
        }
        Stats.Connected();
        using var session = CancellationTokenSource.CreateLinkedTokenSource(ct);
        await SendAsync(new JsonObject
        {
            ["type"] = "hello",
            ["protocol"] = LinkOptions.ProtocolVersion,
            ["agent_version"] = _options.AgentVersion,
            ["connector_code"] = _options.ConnectorCode,
            ["capabilities"] = new JsonArray(_options.Capabilities.Select(c => (JsonNode)c).ToArray()),
            ["first_buffered_sequence"] = _queue.FirstBuffered is { } first ? first : null,
        }, session.Token).ConfigureAwait(false);
        var sender = Task.Run(() => SenderLoopAsync(session.Token), session.Token);
        Task? heartbeat = null;
        try
        {
            await foreach (var text in ReceiveAsync(ws, session.Token).ConfigureAwait(false))
            {
                var frame = JsonNode.Parse(text) as JsonObject;
                if (frame?["type"]?.GetValue<string>() is not { } type) continue;
                switch (type)
                {
                    case "welcome":
                        var next = frame["next_expected_sequence"]!.GetValue<long>();
                        _queue.AckThrough(next - 1);
                        lock (_state)
                        {
                            _welcomed = true;
                            _lastSent = next - 1;
                            _rewindTo = null;
                        }
                        _attempt = 0;
                        LastWelcome = DateTimeOffset.UtcNow;
                        Stats.Welcomed();
                        var seconds = frame["heartbeat_interval_seconds"]!.GetValue<int>();
                        heartbeat ??= Task.Run(() => HeartbeatLoopAsync(TimeSpan.FromSeconds(seconds), session.Token),
                            session.Token);
                        _flushSignal.Release();
                        Welcomed?.Invoke();
                        break;
                    case "ack":
                        Stats.Acked();
                        _queue.AckThrough(frame["sequence_no"]!.GetValue<long>());
                        break;
                    case "resend":
                        Stats.Resent();
                        var resendFrom = frame["from_sequence"]!.GetValue<long>();
                        lock (_state) _rewindTo = Math.Min(_rewindTo ?? long.MaxValue, resendFrom);
                        _flushSignal.Release();
                        break;
                    case "throttle":
                        Stats.Throttled();
                        _maxPerSecond = frame["max_messages_per_second"]!.GetValue<int>();
                        break;
                    case "command":
                        await OnCommandAsync(frame, session.Token).ConfigureAwait(false);
                        break;
                    case "error":
                        _log.LogWarning("platform error {Code}: {Message}", frame["code"], frame["message"]);
                        break;
                }
            }
            if (ws.CloseStatus is (WebSocketCloseStatus)4401) MarkRevoked("certificate revoked (4401)");
            else _log.LogInformation("link closed {Status} {Description}", ws.CloseStatus, ws.CloseStatusDescription);
        }
        finally
        {
            await session.CancelAsync().ConfigureAwait(false);
            lock (_state) _welcomed = false;
            await IgnoreCancellation(sender).ConfigureAwait(false);
            if (heartbeat is not null) await IgnoreCancellation(heartbeat).ConfigureAwait(false);
            ws.Dispose();
        }
    }

    private async Task SenderLoopAsync(CancellationToken ct)
    {
        while (!ct.IsCancellationRequested)
        {
            await _flushSignal.WaitAsync(ct).ConfigureAwait(false);
            if (!Connected) continue;
            bool again;
            do
            {
                again = false;
                long from;
                lock (_state)
                {
                    // A resend request rewinds the cursor; it is applied here so a pass in flight cannot undo it.
                    if (_rewindTo is { } rewind)
                    {
                        _lastSent = rewind - 1;
                        _rewindTo = null;
                    }
                    from = _lastSent + 1;
                }
                var batch = _queue.Pending(from);
                foreach (var m in batch)
                {
                    lock (_state) again = _rewindTo is not null;
                    if (again) break;
                    if (Chaos.ReorderNext && _held is null)
                    {
                        // Hold this one back and send it after the next (the platform must ask for a resend).
                        _held = m;
                        lock (_state) _lastSent = Math.Max(_lastSent, m.SequenceNo);
                        continue;
                    }
                    await SendMessageAsync(m, ct).ConfigureAwait(false);
                    if (_held is { } held)
                    {
                        _held = null;
                        Chaos.ReorderNext = false;
                        await SendMessageAsync(held, ct).ConfigureAwait(false);
                    }
                    if (Chaos.DuplicateNext)
                    {
                        Chaos.DuplicateNext = false;
                        await SendMessageAsync(m, ct).ConfigureAwait(false);
                    }
                    lock (_state) _lastSent = Math.Max(_lastSent, m.SequenceNo);
                    if (_maxPerSecond > 0)
                        await Task.Delay(TimeSpan.FromMilliseconds(1000.0 / _maxPerSecond), ct).ConfigureAwait(false);
                }
                // A full page means more is waiting.
                if (!again && batch.Count == PageSize) again = true;
            }
            while (again && !ct.IsCancellationRequested);
            if (_held is { } alone && Volatile.Read(ref _draining) > 0)
            {
                // Asked to drain and nothing else will follow to release a held message: send it now.
                _held = null;
                Chaos.ReorderNext = false;
                await SendMessageAsync(alone, ct).ConfigureAwait(false);
            }
        }
    }

    private async Task HeartbeatLoopAsync(TimeSpan interval, CancellationToken ct)
    {
        using var timer = new PeriodicTimer(interval);
        while (await timer.WaitForNextTickAsync(ct).ConfigureAwait(false))
            await SendAsync(new JsonObject
            {
                ["type"] = "heartbeat",
                ["sent_at"] = DateTimeOffset.UtcNow.ToString("yyyy-MM-ddTHH:mm:ss.fffZ", CultureInfo.InvariantCulture),
                ["queue_depth"] = _queue.Depth,
            }, ct).ConfigureAwait(false);
    }

    private async Task OnCommandAsync(JsonObject frame, CancellationToken ct)
    {
        var commandId = frame["command_id"]?.GetValue<string>();
        // A command that is not signed by the pinned platform key, or is meant for another instance, is never run.
        if (commandId is null || !_signature.Verify(frame)
            || frame["instance_id"]?.GetValue<string>() != _identity.InstanceId)
        {
            Stats.Rejected();
            _log.LogWarning("command rejected: signature or instance does not match");
            return;
        }
        var previous = _queue.ExecutedCommand(commandId);
        CommandOutcome outcome;
        if (previous is { } done)
            outcome = new CommandOutcome(done.status == "ACKNOWLEDGED", done.error);
        else
        {
            Stats.Executed();
            outcome = await ExecuteAsync(frame, ct).ConfigureAwait(false);
            _queue.RecordCommand(commandId, outcome.Acknowledged ? "ACKNOWLEDGED" : "FAILED", outcome.Error);
        }
        await SendAsync(new JsonObject
        {
            ["type"] = "command_result",
            ["command_id"] = commandId,
            ["status"] = outcome.Acknowledged ? "ACKNOWLEDGED" : "FAILED",
            ["error"] = outcome.Error,
        }, ct).ConfigureAwait(false);
    }

    private async Task<CommandOutcome> ExecuteAsync(JsonObject frame, CancellationToken ct)
    {
        if (frame["expires_at"] is JsonValue expires
            && DateTimeOffset.TryParse(expires.GetValue<string>(), CultureInfo.InvariantCulture,
                DateTimeStyles.AssumeUniversal, out var at)
            && at < DateTimeOffset.UtcNow)
            return CommandOutcome.Failed("expired");
        var type = frame["command_type"]!.GetValue<string>();
        if (!_handlers.TryGetValue(type, out var handler))
            return CommandOutcome.Failed($"unsupported command {type}");
        try
        {
            return await handler.ExecuteAsync(frame["payload"], ct).ConfigureAwait(false);
        }
        catch (Exception e) when (e is not OperationCanceledException)
        {
            _log.LogError(e, "command {Type} failed", type);
            return CommandOutcome.Failed(e.Message);
        }
    }

    private Task SendMessageAsync(QueuedMessage m, CancellationToken ct) => SendAsync(MessageFrame(m), ct);

    private static JsonObject MessageFrame(QueuedMessage m) => new()
    {
        ["type"] = "message",
        ["sequence_no"] = m.SequenceNo,
        ["source_message_id"] = m.SourceMessageId,
        ["message_type"] = m.MessageType,
        ["occurred_at"] = m.OccurredAt,
        ["payload"] = JsonNode.Parse(m.PayloadJson),
    };

    private async Task SendAsync(JsonObject frame, CancellationToken ct)
    {
        ClientWebSocket? ws;
        lock (_state) ws = _ws;
        if (ws is not { State: WebSocketState.Open }) return;
        var bytes = Encoding.UTF8.GetBytes(frame.ToJsonString(Json));
        await _sendLock.WaitAsync(ct).ConfigureAwait(false);
        try
        {
            await ws.SendAsync(bytes, WebSocketMessageType.Text, endOfMessage: true, ct).ConfigureAwait(false);
        }
        finally
        {
            _sendLock.Release();
        }
    }

    private static async IAsyncEnumerable<string> ReceiveAsync(
        ClientWebSocket ws, [System.Runtime.CompilerServices.EnumeratorCancellation] CancellationToken ct)
    {
        var buffer = new byte[64 * 1024];
        using var message = new MemoryStream();
        while (ws.State == WebSocketState.Open)
        {
            WebSocketReceiveResult result;
            try
            {
                result = await ws.ReceiveAsync(buffer, ct).ConfigureAwait(false);
            }
            catch (WebSocketException)
            {
                yield break;
            }
            if (result.MessageType == WebSocketMessageType.Close) yield break;
            message.Write(buffer, 0, result.Count);
            if (!result.EndOfMessage) continue;
            yield return Encoding.UTF8.GetString(message.GetBuffer(), 0, (int)message.Length);
            message.SetLength(0);
        }
    }

    private void MarkRevoked(string reason)
    {
        Revoked = true;
        _log.LogError("link stopped: {Reason}; re-enroll the agent with a new token", reason);
    }

    private TimeSpan Backoff()
    {
        var max = _options.MaxBackoff.TotalMilliseconds;
        var baseMs = Math.Min(max, 1000 * Math.Pow(2, Math.Min(_attempt++, 6)));
        return TimeSpan.FromMilliseconds(baseMs / 2 + Random.Shared.NextDouble() * (baseMs / 2));
    }

    private static async Task IgnoreCancellation(Task task)
    {
        try
        {
            await task.ConfigureAwait(false);
        }
        catch (OperationCanceledException)
        {
            // Session over.
        }
        catch (WebSocketException)
        {
            // Session over.
        }
    }
}
