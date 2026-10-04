using System.Globalization;
using System.Net.Http.Headers;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json.Nodes;
using Hotella.Agent.Core.Json;
using Hotella.Agent.Core.Link;
using Microsoft.Data.Sqlite;
using Microsoft.Extensions.Logging;

namespace Hotella.Agent.Ows;

/// <summary>
/// The OWS poller for <c>OPERA5_OWS</c> (ADR-0014, BUILD_PLAN §10 Phase 10): every <see cref="OwsSettings.PollSeconds"/>
/// it asks OWS for the reservations arriving from yesterday to <see cref="OwsSettings.WindowDays"/> ahead, compares
/// each with what it forwarded before (a local SQLite snapshot of fingerprints) and forwards only what changed, as
/// <c>OWS_RESERVATION</c> messages (NEW, CHANGE, CANCEL, NOSHOW) through the durable link. Nothing is ever written to
/// OPERA. The message id is derived from the reservation and its fingerprint, so a repeat is a no-op on the platform.
/// </summary>
public sealed class OwsAdapter : IDisposable
{
    public const string ConnectorCode = "OPERA5_OWS";
    public const string MessageType = "OWS_RESERVATION";

    private readonly OwsSettings _settings;
    private readonly string _instanceId;
    private readonly Func<string?> _password;
    private readonly HttpClient _http;
    private readonly ILogger _log;
    private readonly SqliteConnection _db;
    private readonly Func<DateTimeOffset> _now;

    public OwsAdapter(
        OwsSettings settings, string instanceId, Func<string?> password, string snapshotPath, ILogger logger,
        HttpMessageHandler? handler = null, Func<DateTimeOffset>? now = null)
    {
        ArgumentNullException.ThrowIfNull(settings);
        _settings = settings;
        _instanceId = instanceId;
        _password = password;
        _log = logger;
        _now = now ?? (() => DateTimeOffset.UtcNow);
        _http = new HttpClient(handler ?? new SocketsHttpHandler(), disposeHandler: true)
        {
            BaseAddress = settings.Url,
            Timeout = TimeSpan.FromSeconds(settings.TimeoutSeconds),
        };
        _db = new SqliteConnection(new SqliteConnectionStringBuilder
        {
            DataSource = snapshotPath,
            Mode = snapshotPath == ":memory:" ? SqliteOpenMode.Memory : SqliteOpenMode.ReadWriteCreate,
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
    public int Failures { get; private set; }
    public long Forwarded { get; private set; }
    public string? LastError { get; private set; }

    public async Task RunAsync(IMessagePublisher publisher, CancellationToken ct)
    {
        using var timer = new PeriodicTimer(TimeSpan.FromSeconds(_settings.PollSeconds));
        do
        {
            try
            {
                await PollOnceAsync(publisher, ct).ConfigureAwait(false);
            }
            catch (OperationCanceledException) when (ct.IsCancellationRequested)
            {
                return;
            }
#pragma warning disable CA1031 // A failed poll is retried at the next tick; the agent keeps running.
            catch (Exception e)
#pragma warning restore CA1031
            {
                Failures++;
                LastError = e is OwsFaultException or HttpRequestException or TaskCanceledException ? e.Message : e.GetType().Name;
                _log.LogWarning("OWS poll failed: {Reason}", LastError);
            }
        }
        while (await timer.WaitForNextTickAsync(ct).ConfigureAwait(false));
    }

    /// <summary>One poll: query the window, forward what changed; returns how many messages were forwarded.</summary>
    public async Task<int> PollOnceAsync(IMessagePublisher publisher, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(publisher);
        var password = _password() ?? throw new OwsFaultException(
            $"the OWS password is not set (hotella-agent secret set {_settings.PasswordSecret})");
        var today = DateOnly.FromDateTime(_now().UtcDateTime);
        var request = OwsSoap.FutureBookingSummaryRequest(_settings, password, today.AddDays(-1),
            today.AddDays(_settings.WindowDays), _now());
        using var content = new StringContent(request, Encoding.UTF8, "text/xml");
        content.Headers.ContentType = new MediaTypeHeaderValue("text/xml") { CharSet = "utf-8" };
        using var message = new HttpRequestMessage(HttpMethod.Post, OwsSoap.ReservationService) { Content = content };
        message.Headers.Add("SOAPAction", $"\"{OwsSoap.FutureBookingSummaryAction}\"");
        using var response = await _http.SendAsync(message, ct).ConfigureAwait(false);
        var body = await response.Content.ReadAsStringAsync(ct).ConfigureAwait(false);
        // A SOAP fault arrives with HTTP 500: the parser turns it into its reason.
        var reservations = OwsSoap.ParseFutureBookingSummary(body);
        if (!response.IsSuccessStatusCode) throw new OwsFaultException($"OWS answered HTTP {(int)response.StatusCode}");
        Polls++;
        var forwarded = 0;
        foreach (var r in reservations)
            if (Forward(publisher, r)) forwarded++;
        Forwarded += forwarded;
        return forwarded;
    }

    private bool Forward(IMessagePublisher publisher, OwsReservation r)
    {
        var action = r.Status switch
        {
            "CANCELED" or "CANCELLED" => "CANCEL",
            "NOSHOW" or "NO_SHOW" => "NOSHOW",
            "CHECKEDOUT" or "CHECKED_OUT" => null,
            _ => "ACTIVE",
        };
        if (action is null) return false;
        var fingerprint = Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(
            r.Status + "\n" + CanonicalJson.Serialize(r.Reservation))));
        var known = Known(r.ReservationId);
        if (known?.fingerprint == fingerprint) return false;
        if (action != "ACTIVE" && (known is null || known.Value.status is "CANCEL" or "NOSHOW"))
        {
            // Never seen as a live booking: nothing on the platform to cancel.
            Remember(r.ReservationId, fingerprint, action);
            return false;
        }
        var owsAction = action == "ACTIVE" ? (known is null ? "NEW" : "CHANGE") : action;
        var payload = new JsonObject
        {
            ["action"] = owsAction,
            ["modifiedAt"] = ModifiedAt(r.UpdatedAt),
            ["reservation"] = action == "ACTIVE"
                ? r.Reservation.DeepClone()
                : new JsonObject { ["reservationId"] = r.ReservationId },
        };
        var id = "ows-" + Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(
            _instanceId + "\n" + r.ReservationId + "\n" + owsAction + "\n" + fingerprint)));
        publisher.Publish(id, MessageType, null, payload.ToJsonString());
        Remember(r.ReservationId, fingerprint, action == "ACTIVE" ? "ACTIVE" : action);
        return true;
    }

    private string ModifiedAt(string? updated) =>
        updated is not null && DateTimeOffset.TryParse(updated, CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal, out var at)
            ? at.ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ss.fffZ", CultureInfo.InvariantCulture)
            : _now().UtcDateTime.ToString("yyyy-MM-ddTHH:mm:ss.fffZ", CultureInfo.InvariantCulture);

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

    public void Dispose()
    {
        _http.Dispose();
        _db.Dispose();
    }
}
