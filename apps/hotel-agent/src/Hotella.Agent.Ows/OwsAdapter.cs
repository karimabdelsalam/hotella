using System.Globalization;
using System.Net.Http.Headers;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json.Nodes;
using Hotella.Agent.Core.Hosting;
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
public sealed class OwsAdapter : IAdapterHealth, IDisposable
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
    private int _failingInARow;

    public bool Up => Polls > 0 && _failingInARow == 0;
    public string? Problem => Up ? null : LastError ?? "no successful OWS poll yet";

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
                _failingInARow++;
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
        var today = DateOnly.FromDateTime(_now().UtcDateTime);
        var reservations = OwsSoap.ParseFutureBookingSummary(await CallAsync(OwsSoap.ReservationService,
            OwsSoap.FutureBookingSummaryAction,
            password => OwsSoap.FutureBookingSummaryRequest(_settings, password, today.AddDays(-1),
                today.AddDays(_settings.WindowDays), _now()), ct).ConfigureAwait(false));
        Polls++;
        _failingInARow = 0;
        LastError = null;
        var forwarded = 0;
        foreach (var r in reservations)
            if (Forward(publisher, r)) forwarded++;
        Forwarded += forwarded;
        return forwarded;
    }

    /// <summary>
    /// One OWS call: the request built with the password from the protected store, the SOAP action, the answer's body.
    /// A SOAP fault (HTTP 500) becomes its reason; nothing of the request or answer is logged.
    /// </summary>
    private async Task<string> CallAsync(string service, string action, Func<string, string> request, CancellationToken ct)
    {
        var password = _password() ?? throw new OwsFaultException(
            $"the OWS password is not set (hotella-agent secret set {_settings.PasswordSecret})");
        using var content = new StringContent(request(password), Encoding.UTF8, "text/xml");
        content.Headers.ContentType = new MediaTypeHeaderValue("text/xml") { CharSet = "utf-8" };
        using var message = new HttpRequestMessage(HttpMethod.Post, service) { Content = content };
        message.Headers.Add("SOAPAction", $"\"{action}\"");
        using var response = await _http.SendAsync(message, ct).ConfigureAwait(false);
        var body = await response.Content.ReadAsStringAsync(ct).ConfigureAwait(false);
        OwsSoap.Checked(body);
        if (!response.IsSuccessStatusCode) throw new OwsFaultException($"OWS answered HTTP {(int)response.StatusCode}");
        return body;
    }

    /// <summary>The standard reads of OWS connector v1 (guide §4.2, §8.1), answered over link protocol 2.</summary>
    public IReadOnlyList<IQueryHandler> Queries() =>
    [
        new Query("LOOKUP_RESERVATION", async (p, ct) =>
        {
            var byId = Param(p, "reservation_id");
            var confirmation = byId is null ? Param(p, "confirmation_number")
                ?? throw new FormatException("a confirmation number or reservation id is required") : null;
            var found = OwsSoap.ParseFetchBooking(await CallAsync(OwsSoap.ReservationService, OwsSoap.FetchBookingAction,
                password => OwsSoap.FetchBookingRequest(_settings, password, confirmation, byId, _now()), ct).ConfigureAwait(false));
            return Rows(found is null ? [] : [OwsRows.Reservation(found)]);
        }),
        new Query("LIST_ARRIVALS", async (p, ct) =>
        {
            var from = Day(p, "from");
            var to = Day(p, "to");
            var found = OwsSoap.ParseFutureBookingSummary(await CallAsync(OwsSoap.ReservationService,
                OwsSoap.FutureBookingSummaryAction,
                password => OwsSoap.FutureBookingSummaryRequest(_settings, password, from, to, _now()), ct).ConfigureAwait(false));
            // FutureBookingSummary also lists cancellations of the window; an arrivals list does not.
            return Rows([.. found.Select(OwsRows.Reservation).Where(r => r?["status"]?.GetValue<string>() != "CANCELLED")]);
        }),
        new Query("LOOKUP_PROFILE", async (p, ct) =>
        {
            var id = Param(p, "profile_id") ?? throw new FormatException("profile_id is required");
            var profile = await FetchProfileAsync(id, ct).ConfigureAwait(false);
            return Rows(profile is null ? [] : [OwsRows.Profile(profile)]);
        }),
    ];

    /// <summary>The standard writes of OWS connector v1: additive contact updates only (guide §4.2).</summary>
    public IReadOnlyList<ICommandHandler> Commands() => [new ProfileContactHandler(this)];

    public int ContactWrites { get; private set; }

    private async Task<OwsProfile?> FetchProfileAsync(string profileId, CancellationToken ct) =>
        OwsSoap.ParseFetchProfile(await CallAsync(OwsSoap.NameService, OwsSoap.FetchProfileAction,
            password => OwsSoap.FetchProfileRequest(_settings, password, profileId, _now()), ct).ConfigureAwait(false), profileId);

    /// <summary>
    /// UPDATE_PROFILE_CONTACT: reads the profile first and inserts only what OPERA does not already hold, so a command
    /// repeated after a timeout changes nothing (guide §8.3: a write is re-checked by a read, never blindly retried).
    /// </summary>
    internal async Task<CommandOutcome> UpdateContactAsync(string profileId, string? email, string? phone, CancellationToken ct)
    {
        var profile = await FetchProfileAsync(profileId, ct).ConfigureAwait(false);
        if (profile is null) return CommandOutcome.Failed("OPERA has no such profile");
        if (email is not null && !profile.Emails.Contains(email, StringComparer.OrdinalIgnoreCase))
        {
            await CallAsync(OwsSoap.NameService, OwsSoap.InsertEmailAction,
                password => OwsSoap.InsertEmailRequest(_settings, password, profileId, email, _now()), ct).ConfigureAwait(false);
            ContactWrites++;
        }
        if (phone is not null && !profile.Phones.Any(p => Digits(p) == Digits(phone)))
        {
            await CallAsync(OwsSoap.NameService, OwsSoap.InsertPhoneAction,
                password => OwsSoap.InsertPhoneRequest(_settings, password, profileId, phone, _now()), ct).ConfigureAwait(false);
            ContactWrites++;
        }
        return CommandOutcome.Ok;
    }

    private static string Digits(string phone) => new([.. phone.Where(char.IsAsciiDigit)]);

    private static QueryAnswer Rows(IEnumerable<JsonObject?> rows)
    {
        var list = rows.OfType<JsonObject>().ToList();
        return new QueryAnswer([.. list.Take(LinkOptions.MaxQueryRows)], list.Count > LinkOptions.MaxQueryRows);
    }

    private static string? Param(JsonObject p, string name) =>
        p[name]?.GetValue<string>() is { Length: > 0 } v ? v : null;

    private static DateOnly Day(JsonObject p, string name) =>
        DateOnly.ParseExact(Param(p, name) ?? throw new FormatException($"{name} is required"), "yyyy-MM-dd", CultureInfo.InvariantCulture);

    private sealed class Query(string type, Func<JsonObject, CancellationToken, Task<QueryAnswer>> run) : IQueryHandler
    {
        public string QueryType => type;

        public async Task<QueryAnswer> ExecuteAsync(JsonObject parameters, CancellationToken ct)
        {
            try
            {
                return await run(parameters, ct).ConfigureAwait(false);
            }
            catch (OwsFaultException e)
            {
                // The fault's reason (no guest data) is what the platform may show.
                throw new QueryRefusedException(e.Message);
            }
        }
    }

    private sealed class ProfileContactHandler(OwsAdapter adapter) : ICommandHandler
    {
        public string CommandType => "UPDATE_PROFILE_CONTACT";

        public async Task<CommandOutcome> ExecuteAsync(JsonNode? payload, CancellationToken ct)
        {
            var profileId = payload?["profile_id"]?.GetValue<string>();
            var email = payload?["email"]?.GetValue<string>();
            var phone = payload?["phone"]?.GetValue<string>();
            if (string.IsNullOrWhiteSpace(profileId) || (email is null && phone is null))
                return CommandOutcome.Failed("a profile and an e-mail or phone are required");
            try
            {
                return await adapter.UpdateContactAsync(profileId, email, phone, ct).ConfigureAwait(false);
            }
            catch (Exception e) when (e is OwsFaultException or HttpRequestException or TaskCanceledException)
            {
                return CommandOutcome.Failed(e is OwsFaultException ? e.Message : $"OWS unreachable ({e.GetType().Name})");
            }
        }
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
