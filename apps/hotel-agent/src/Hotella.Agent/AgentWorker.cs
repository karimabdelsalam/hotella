using Hotella.Agent.Core.Hosting;
using Hotella.Agent.Core.Licensing;
using Hotella.Agent.Core.Link;
using Hotella.Agent.Core.Queue;
using Hotella.Agent.Core.Security;
using Hotella.Agent.Fias;
using Hotella.Agent.OperaDb;
using Hotella.Agent.Ows;
using Hotella.Agent.Updater;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;

namespace Hotella.Agent;

/// <summary>Exit codes a service manager (or the installer) can act on.</summary>
internal static class ExitCodes
{
    public const int Ok = 0;
    public const int Usage = 1;
    public const int NotConfigured = 2;
    public const int Revoked = 3;
    public const int Refused = 4;

    /// <summary>A new version is in place: the service manager restarts into it.</summary>
    public const int RestartIntoUpdate = 10;

    /// <summary>The candidate failed its probation: the service manager restarts into the previous version.</summary>
    public const int RolledBack = 11;
}

/// <summary>
/// Runs the link (ADR-0017) for as long as the service runs: the durable queue, the mutual-TLS link with reconnects,
/// and upkeep every hour — renew the device certificate before it expires and drop acknowledged history past the
/// retention. The connector's adapter (OPERA5_FIAS: the IFC8 session; OPERA5_OWS: the OWS poller; OPERA5_DB: the
/// read-only database reads) runs beside the link, publishes into it and handles its commands and reads. One agent service serves one integration instance; a hotel with
/// FIAS and OWS runs two (BUILD_PLAN 10.3 notes).
/// </summary>
internal sealed partial class AgentWorker(
    AgentSettings settings,
    FiasSettings fiasSettings,
    OwsSettings owsSettings,
    OperaDbSettings operaDbSettings,
    UpdateSettings updateSettings,
    IHostApplicationLifetime lifetime,
    ILoggerFactory loggers) : BackgroundService
{
    private static readonly TimeSpan UpkeepEvery = TimeSpan.FromHours(1);
    private readonly ILogger _log = loggers.CreateLogger("hotella.agent");

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        var problems = AgentHost.Problems(settings, fiasSettings, owsSettings, operaDbSettings);
        var store = new IdentityStore(settings.DataDirectory);
        var identity = problems.Count == 0 ? store.Load() : null;
        if (problems.Count > 0 || identity is null)
        {
            foreach (var p in problems) _log.LogCritical("configuration: {Problem}", p);
            if (problems.Count == 0) _log.LogCritical("not enrolled: run `hotella-agent enroll` with a token from the platform");
            Stop(ExitCodes.NotConfigured);
            return;
        }

        using var queue = DurableOutbox.Open(Path.Combine(settings.DataDirectory, "queue.db"));
        var options = new LinkOptions(settings.Gateway!, settings.ConnectorCode, settings.Capabilities.ToList(),
            Cli.AgentVersion);
        using var fias = settings.ConnectorCode == FiasAdapter.ConnectorCode
            ? new FiasAdapter(fiasSettings, identity.InstanceId, loggers.CreateLogger("hotella.fias"))
            : null;
        var secrets = new SecretStore(settings.DataDirectory);
        using var ows = settings.ConnectorCode == OwsAdapter.ConnectorCode
            ? new OwsAdapter(owsSettings, identity.InstanceId, () => secrets.Get(owsSettings.PasswordSecret),
                Path.Combine(settings.DataDirectory, "ows.db"), loggers.CreateLogger("hotella.ows"))
            : null;
        using var operaDb = settings.ConnectorCode == OperaDbAdapter.ConnectorCode
            ? new OperaDbAdapter(operaDbSettings, identity.InstanceId, AgentHost.OperaDataSource(operaDbSettings, secrets),
                Path.Combine(settings.DataDirectory, "opera-db.db"), loggers.CreateLogger("hotella.opera-db"))
            : null;
        await using var link = new LinkClient(identity, queue, options, fias?.Commands() ?? [],
            loggers.CreateLogger("hotella.link"), operaDb?.Queries());
        link.Welcomed += () => _log.LogInformation("linked as instance {Instance}", identity.InstanceId);
        var licences = new LicenceStore(settings.DataDirectory, new CommandSignature(identity.CommandPublicKeyPem),
            identity.InstanceId);
        link.LicenceOffered += token =>
        {
            if (licences.Offer(token))
                _log.LogInformation("licence valid until {ExpiresAt:u}", licences.Current!.ExpiresAt);
        };
        link.CommandGate = () => licences.CommandRefusal(DateTimeOffset.UtcNow);
        IAdapterHealth? pms = (IAdapterHealth?)fias ?? (IAdapterHealth?)ows ?? operaDb;

        using var session = CancellationTokenSource.CreateLinkedTokenSource(stoppingToken);
        var running = link.RunAsync(session.Token);
        var updater = updateSettings.Updater();
        var upkeep = UpkeepAsync(store, queue, link, updater, session.Token);
        var health = HealthAsync(store, queue, link, licences, pms, updater, session.Token);
        // The PMS side keeps reading while the platform is unreachable: records wait in the durable queue.
        var adapter = fias?.RunAsync(link, session.Token) ?? ows?.RunAsync(link, session.Token)
            ?? operaDb?.RunAsync(link, session.Token) ?? Task.CompletedTask;
        await Task.WhenAny(running, upkeep).ConfigureAwait(false);
        await session.CancelAsync().ConfigureAwait(false);
        await Task.WhenAll(running, Quietly(upkeep), Quietly(adapter), Quietly(health)).ConfigureAwait(false);

        if (link.Revoked)
        {
            _log.LogCritical("the platform revoked this agent's certificate; enroll again with a new token");
            Stop(ExitCodes.Revoked);
        }
    }

    private async Task UpkeepAsync(
        IdentityStore store, DurableOutbox queue, LinkClient link, AgentUpdater? updater, CancellationToken ct)
    {
        using var timer = new PeriodicTimer(UpkeepEvery);
        var lastCheck = DateTimeOffset.MinValue;
        do
        {
            var evicted = queue.Evict(TimeSpan.FromDays(settings.QueueRetentionDays));
            if (evicted > 0) _log.LogWarning("dropped {Count} messages older than the retention", evicted);
            await RenewIfDueAsync(store, link, ct).ConfigureAwait(false);
            if (updater is not null && updateSettings.Auto
                && DateTimeOffset.UtcNow - lastCheck >= TimeSpan.FromHours(updateSettings.CheckHours)
                && updater.State.Status != UpdateStatus.Probation)
            {
                lastCheck = DateTimeOffset.UtcNow;
                if (await TryUpdateAsync(updater, ct).ConfigureAwait(false)) return;
            }
        }
        while (await timer.WaitForNextTickAsync(ct).ConfigureAwait(false));
    }

    /// <summary>Applies a newer signed release and asks for a restart into it; true when the service should stop.</summary>
    private async Task<bool> TryUpdateAsync(AgentUpdater updater, CancellationToken ct)
    {
        try
        {
            var manifest = await updater.CheckAsync(updateSettings.ManifestUrl!, UpdateSettings.Running, ct)
                .ConfigureAwait(false);
            if (manifest is null) return false;
            await updater.StageAsync(manifest, ct).ConfigureAwait(false);
            updater.Switch(manifest.Version, UpdateSettings.Running, DateTimeOffset.UtcNow);
            _log.LogWarning("updated to {Version}; restarting into it (probation {Minutes} min)",
                manifest.Version, (int)AgentUpdater.Probation.TotalMinutes);
            Stop(ExitCodes.RestartIntoUpdate);
            return true;
        }
        catch (Exception e) when (e is HttpRequestException or InvalidDataException or IOException
                                    or System.Text.Json.JsonException or TaskCanceledException)
        {
            _log.LogWarning("update check failed: {Reason}", e.Message);
            return false;
        }
    }

    /// <summary>Writes health.json every minute (and logs when the status changes).</summary>
    private async Task HealthAsync(
        IdentityStore store, DurableOutbox queue, LinkClient link, LicenceStore licences, IAdapterHealth? pms,
        AgentUpdater? updater, CancellationToken ct)
    {
        using var timer = new PeriodicTimer(TimeSpan.FromMinutes(1));
        DateTimeOffset? downSince = null;
        var last = (HealthStatus?)null;
        do
        {
            var now = DateTimeOffset.UtcNow;
            downSince = link.Connected ? null : downSince ?? now;
            var inputs = new HealthInputs(now, link.Connected, downSince, pms?.Up, pms?.Problem,
                licences.StateAt(now), queue.Depth, RenewalPolicy.Validity(store.Load()!.CertificatePem).notAfter);
            var report = AgentHealth.Report(inputs, Cli.AgentVersion);
            var path = Path.Combine(settings.DataDirectory, "health.json");
            await File.WriteAllTextAsync(path + ".tmp", report.ToJsonString(), ct).ConfigureAwait(false);
            File.Move(path + ".tmp", path, overwrite: true);
            var (status, reasons) = AgentHealth.Classify(inputs);
            if (updater is not null && !Probation(updater, link.Connected && pms?.Up != false, now)) return;
            if (status != last)
            {
                if (status == HealthStatus.Healthy) _log.LogInformation("health: HEALTHY");
                else _log.LogWarning("health: {Status}: {Reasons}", status, string.Join("; ", reasons));
                last = status;
            }
        }
        while (await timer.WaitForNextTickAsync(ct).ConfigureAwait(false));
    }

    /// <summary>A candidate on probation stays once its links are up; past the probation it goes back. False = stop.</summary>
    private bool Probation(AgentUpdater updater, bool linked, DateTimeOffset now)
    {
        if (updater.State.Status != UpdateStatus.Probation) return true;
        if (linked)
        {
            updater.Confirm(UpdateSettings.Running);
            _log.LogInformation("update {Version} confirmed", UpdateSettings.Running);
            return true;
        }
        if (!updater.ProbationFailed(UpdateSettings.Running, now)) return true;
        updater.Rollback("the new version stayed unhealthy");
        _log.LogError("update {Version} rolled back: it stayed unhealthy", UpdateSettings.Running);
        Stop(ExitCodes.RolledBack);
        return false;
    }

    private async Task RenewIfDueAsync(IdentityStore store, LinkClient link, CancellationToken ct)
    {
        var identity = store.Load()!;
        var (notBefore, notAfter) = RenewalPolicy.Validity(identity.CertificatePem);
        if (!RenewalPolicy.IsDue(notBefore, notAfter, DateTimeOffset.UtcNow, settings.RenewAtRemainingFraction)) return;
        try
        {
            var renewed = await Enrollment.RenewAsync(settings.Gateway!, identity, ct).ConfigureAwait(false);
            store.Save(renewed);
            link.UseIdentity(renewed);
            _log.LogInformation("certificate renewed; valid until {NotAfter:u}", RenewalPolicy.Validity(renewed.CertificatePem).notAfter);
        }
        catch (Exception e) when (e is HttpRequestException or GatewayHttpException or IOException)
        {
            // Retried at the next upkeep; the current certificate is still valid for a third of its lifetime.
            _log.LogWarning("certificate renewal failed ({Reason}); valid until {NotAfter:u}", e.Message, notAfter);
        }
    }

    private void Stop(int exitCode)
    {
        Environment.ExitCode = exitCode;
        lifetime.StopApplication();
    }

    private static async Task Quietly(Task task)
    {
        try
        {
            await task.ConfigureAwait(false);
        }
        catch (OperationCanceledException)
        {
            // Stopping.
        }
    }
}
