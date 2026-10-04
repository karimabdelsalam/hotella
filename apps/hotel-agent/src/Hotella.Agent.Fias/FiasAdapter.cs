using System.Net;
using System.Net.Sockets;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json.Nodes;
using Hotella.Agent.Core.Link;
using Microsoft.Extensions.Logging;

namespace Hotella.Agent.Fias;

/// <summary>
/// The IFC8 FIAS link for <c>OPERA5_FIAS</c> (ADR-0014, BUILD_PLAN §10 Phase 10). It keeps one TCP session with IFC8 —
/// link start (LS), description (LD), the records it wants (LR), alive (LA), end (LE) — and forwards every business
/// record verbatim as a <c>FIAS_RECORD</c> message through the durable link; the platform parses it. The id of a
/// forwarded message is a hash of the instance and the record, so a record IFC8 sends again after a reconnect is a
/// no-op on the platform. Commands: <c>RESYNC_IN_HOUSE</c> asks IFC8 for a database sync (DR); <c>SET_ROOM_STATUS</c>
/// writes a room status (RE) and is advertised only when the hotel enabled it.
/// </summary>
public sealed class FiasAdapter : IDisposable
{
    public const string ConnectorCode = "OPERA5_FIAS";
    public const string MessageType = "FIAS_RECORD";

    /// <summary>The business records the agent asks IFC8 for, with the fields it needs (LR records).</summary>
    internal static readonly (string record, string fields)[] Requested =
    [
        ("GI", "RNG#GNGFGTGLGVGAGDSFDATI"),
        ("GO", "RNG#DATI"),
        ("GC", "RNROG#GNGFGTGLGVDATI"),
        ("RE", "RNRSDATI"),
        ("DS", "DATI"),
        ("DE", "DATI"),
    ];

    private readonly FiasSettings _settings;
    private readonly string _instanceId;
    private readonly ILogger _log;
    private readonly Func<DateTime> _localNow;
    private readonly Encoding _encoding;
    private readonly SemaphoreSlim _writeLock = new(1, 1);
    private volatile Stream? _stream;
    private volatile bool _linkUp;

    public FiasAdapter(FiasSettings settings, string instanceId, ILogger logger, Func<DateTime>? localNow = null)
    {
        ArgumentNullException.ThrowIfNull(settings);
        _settings = settings;
        _instanceId = instanceId;
        _log = logger;
        _localNow = localNow ?? (() => DateTime.Now);
        _encoding = settings.TextEncoding();
    }

    /// <summary>True between IFC8's answer to the link description and the end of the session.</summary>
    public bool LinkUp => _linkUp;

    public int Sessions { get; private set; }
    public long Forwarded { get; private set; }

    /// <summary>The adapter's command handlers, given to the link client.</summary>
    public IEnumerable<ICommandHandler> Commands() => [new ResyncHandler(this), new RoomStatusHandler(this)];

    /// <summary>Connects (or listens), serves the session and reconnects until cancelled.</summary>
    public async Task RunAsync(IMessagePublisher publisher, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(publisher);
        TcpListener? listener = null;
        if (_settings.Mode == FiasConnectMode.Server)
        {
            var address = string.IsNullOrWhiteSpace(_settings.Host) ? IPAddress.Any : IPAddress.Parse(_settings.Host);
            listener = new TcpListener(address, _settings.Port);
            listener.Start(1);
        }
        try
        {
            while (!ct.IsCancellationRequested)
            {
                try
                {
                    using var client = listener is null
                        ? await ConnectAsync(ct).ConfigureAwait(false)
                        : await listener.AcceptTcpClientAsync(ct).ConfigureAwait(false);
                    client.NoDelay = true;
                    await ServeAsync(client.GetStream(), publisher, ct).ConfigureAwait(false);
                }
                catch (OperationCanceledException) when (ct.IsCancellationRequested)
                {
                    break;
                }
#pragma warning disable CA1031 // Whatever ends an IFC8 session, the agent reconnects: it must never stop silently.
                catch (Exception e)
#pragma warning restore CA1031
                {
                    _log.LogWarning("FIAS link down: {Kind}: {Reason}", e.GetType().Name, e.Message);
                }
                try
                {
                    await Task.Delay(TimeSpan.FromSeconds(_settings.ReconnectSeconds), ct).ConfigureAwait(false);
                }
                catch (OperationCanceledException)
                {
                    break;
                }
            }
        }
        finally
        {
            listener?.Stop();
        }
    }

    private async Task<TcpClient> ConnectAsync(CancellationToken ct)
    {
        var client = new TcpClient();
        try
        {
            await client.ConnectAsync(_settings.Host, _settings.Port, ct).ConfigureAwait(false);
            return client;
        }
        catch
        {
            client.Dispose();
            throw;
        }
    }

    /// <summary>One IFC8 session: handshake, records, link alive; returns when IFC8 ends it or goes silent.</summary>
    internal async Task ServeAsync(Stream stream, IMessagePublisher publisher, CancellationToken ct)
    {
        Sessions++;
        _stream = stream;
        _linkUp = false;
        using var session = CancellationTokenSource.CreateLinkedTokenSource(ct);
        var lastHeard = DateTimeOffset.UtcNow;
        var lastSent = DateTimeOffset.UtcNow;
        var linkStarted = false;
        async Task Send(FiasRecord record)
        {
            await WriteAsync(stream, record, session.Token).ConfigureAwait(false);
            lastSent = DateTimeOffset.UtcNow;
        }
        async Task Describe()
        {
            // Answer IFC8's link start: who we are, the records we want, and that we are alive.
            await Send(FiasRecord.Create("LD", _localNow(), ("V#", "1.0"), ("IF", "WW"))).ConfigureAwait(false);
            foreach (var (record, fields) in Requested)
                await Send(new FiasRecord("LR", [new("RI", record), new("FL", fields)])).ConfigureAwait(false);
            await Send(FiasRecord.Create("LA", _localNow())).ConfigureAwait(false);
            linkStarted = true;
        }

        var watchdog = Task.Run(async () =>
        {
            using var timer = new PeriodicTimer(TimeSpan.FromSeconds(1));
            var connectedAt = DateTimeOffset.UtcNow;
            var alive = TimeSpan.FromSeconds(_settings.LinkAliveSeconds);
            while (await timer.WaitForNextTickAsync(session.Token).ConfigureAwait(false))
            {
                var now = DateTimeOffset.UtcNow;
                if (!linkStarted && now - connectedAt > TimeSpan.FromSeconds(_settings.LinkStartSeconds))
                {
                    // IFC8 waits for the interface to start: send LS, it answers with its own.
                    await Send(FiasRecord.Create("LS", _localNow())).ConfigureAwait(false);
                    connectedAt = now;
                }
                if (_linkUp && now - lastSent >= alive) await Send(FiasRecord.Create("LA", _localNow())).ConfigureAwait(false);
                if (now - lastHeard > alive * 3)
                {
                    _log.LogWarning("FIAS link silent for {Seconds} s; reconnecting", (int)(now - lastHeard).TotalSeconds);
                    await session.CancelAsync().ConfigureAwait(false);
                    return;
                }
            }
        }, session.Token);

        try
        {
            await foreach (var text in FiasFraming.ReadAsync(stream, _encoding, session.Token).ConfigureAwait(false))
            {
                lastHeard = DateTimeOffset.UtcNow;
                FiasRecord record;
                try
                {
                    record = FiasRecord.Parse(text);
                }
                catch (FormatException e)
                {
                    // Forwarded anyway would only become a platform parse error; the text may hold guest data, so
                    // only the reason is logged.
                    _log.LogWarning("unreadable FIAS record skipped: {Reason}", e.Message);
                    continue;
                }
                switch (record.Id)
                {
                    case "LS":
                        _linkUp = false;
                        await Describe().ConfigureAwait(false);
                        break;
                    case "LA":
                        if (!_linkUp)
                        {
                            _linkUp = true;
                            _log.LogInformation("FIAS link up");
                        }
                        break;
                    case "LE":
                        _log.LogInformation("IFC8 ended the FIAS link");
                        return;
                    case "LD" or "LR":
                        break;
                    default:
                        publisher.Publish(SourceMessageId(text), MessageType, null,
                            new JsonObject { ["record"] = text }.ToJsonString());
                        Forwarded++;
                        break;
                }
            }
        }
        catch (OperationCanceledException) when (!ct.IsCancellationRequested)
        {
            // The watchdog ended a silent session.
        }
        finally
        {
            _linkUp = false;
            _stream = null;
            await session.CancelAsync().ConfigureAwait(false);
            try
            {
                await watchdog.ConfigureAwait(false);
            }
            catch (Exception e) when (e is OperationCanceledException or IOException or ObjectDisposedException)
            {
                // Session over.
            }
        }
    }

    /// <summary>Same record from the same instance ⇒ same id: a repeat is acknowledged and ignored by the platform.</summary>
    internal string SourceMessageId(string record) =>
        "fias-" + Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(_instanceId + "\n" + record)));

    private async Task WriteAsync(Stream stream, FiasRecord record, CancellationToken ct)
    {
        var frame = FiasFraming.Frame(record.ToString(), _encoding);
        await _writeLock.WaitAsync(ct).ConfigureAwait(false);
        try
        {
            await stream.WriteAsync(frame, ct).ConfigureAwait(false);
            await stream.FlushAsync(ct).ConfigureAwait(false);
        }
        finally
        {
            _writeLock.Release();
        }
    }

    /// <summary>Sends a record to IFC8 when the link is up; a command fails otherwise and the platform may retry it.</summary>
    internal async Task<CommandOutcome> SendCommandAsync(FiasRecord record, CancellationToken ct)
    {
        var stream = _stream;
        if (stream is null || !_linkUp) return CommandOutcome.Failed("FIAS link is down");
        try
        {
            await WriteAsync(stream, record, ct).ConfigureAwait(false);
            return CommandOutcome.Ok;
        }
        catch (IOException e)
        {
            return CommandOutcome.Failed($"FIAS link failed: {e.Message}");
        }
    }

    internal DateTime LocalNow() => _localNow();

    public void Dispose() => _writeLock.Dispose();

    /// <summary>RESYNC_IN_HOUSE → DR (database resync request); IFC8 answers DS, the in-house list, DE.</summary>
    private sealed class ResyncHandler(FiasAdapter adapter) : ICommandHandler
    {
        public string CommandType => "RESYNC_IN_HOUSE";

        public Task<CommandOutcome> ExecuteAsync(JsonNode? payload, CancellationToken ct) =>
            adapter.SendCommandAsync(FiasRecord.Create("DR", adapter.LocalNow()), ct);
    }

    /// <summary>SET_ROOM_STATUS → RE with the FIAS maid status (1–6: dirty/clean/inspected × vacant/occupied).</summary>
    private sealed class RoomStatusHandler(FiasAdapter adapter) : ICommandHandler
    {
        public string CommandType => "SET_ROOM_STATUS";

        public Task<CommandOutcome> ExecuteAsync(JsonNode? payload, CancellationToken ct)
        {
            var room = payload?["room_number"]?.GetValue<string>();
            var status = payload?["status"]?.GetValue<string>();
            var occupied = payload?["occupied"]?.GetValue<bool>();
            if (room is null || occupied is null || RoomStatusCode(status, occupied.Value) is not { } code)
                return Task.FromResult(CommandOutcome.Failed("room, status and occupancy are required for FIAS"));
            return adapter.SendCommandAsync(FiasRecord.Create("RE", adapter.LocalNow(), ("RN", room), ("RS", code)), ct);
        }
    }

    internal static string? RoomStatusCode(string? status, bool occupied) => status switch
    {
        "DIRTY" => occupied ? "2" : "1",
        "CLEAN" => occupied ? "4" : "3",
        "INSPECTED" => occupied ? "6" : "5",
        _ => null,
    };
}
