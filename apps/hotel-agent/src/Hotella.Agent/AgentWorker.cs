using Hotella.Agent.Core.Hosting;
using Hotella.Agent.Core.Link;
using Hotella.Agent.Core.Queue;
using Hotella.Agent.Core.Security;
using Hotella.Agent.Fias;
using Hotella.Agent.Ows;
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
}

/// <summary>
/// Runs the link (ADR-0017) for as long as the service runs: the durable queue, the mutual-TLS link with reconnects,
/// and upkeep every hour — renew the device certificate before it expires and drop acknowledged history past the
/// retention. The connector's adapter (OPERA5_FIAS: the IFC8 session; OPERA5_OWS: the OWS poller) runs beside the
/// link, publishes into it and handles its commands. One agent service serves one integration instance; a hotel with
/// FIAS and OWS runs two (BUILD_PLAN 10.3 notes).
/// </summary>
internal sealed partial class AgentWorker(
    AgentSettings settings,
    FiasSettings fiasSettings,
    OwsSettings owsSettings,
    IHostApplicationLifetime lifetime,
    ILoggerFactory loggers) : BackgroundService
{
    private static readonly TimeSpan UpkeepEvery = TimeSpan.FromHours(1);
    private readonly ILogger _log = loggers.CreateLogger("hotella.agent");

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        var problems = AgentHost.Problems(settings, fiasSettings, owsSettings);
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
        await using var link = new LinkClient(identity, queue, options, fias?.Commands() ?? [],
            loggers.CreateLogger("hotella.link"));
        link.Welcomed += () => _log.LogInformation("linked as instance {Instance}", identity.InstanceId);

        using var session = CancellationTokenSource.CreateLinkedTokenSource(stoppingToken);
        var running = link.RunAsync(session.Token);
        var upkeep = UpkeepAsync(store, queue, link, session.Token);
        // The PMS side keeps reading while the platform is unreachable: records wait in the durable queue.
        var adapter = fias?.RunAsync(link, session.Token) ?? ows?.RunAsync(link, session.Token) ?? Task.CompletedTask;
        await Task.WhenAny(running, upkeep).ConfigureAwait(false);
        await session.CancelAsync().ConfigureAwait(false);
        await Task.WhenAll(running, Quietly(upkeep), Quietly(adapter)).ConfigureAwait(false);

        if (link.Revoked)
        {
            _log.LogCritical("the platform revoked this agent's certificate; enroll again with a new token");
            Stop(ExitCodes.Revoked);
        }
    }

    private async Task UpkeepAsync(IdentityStore store, DurableOutbox queue, LinkClient link, CancellationToken ct)
    {
        using var timer = new PeriodicTimer(UpkeepEvery);
        do
        {
            var evicted = queue.Evict(TimeSpan.FromDays(settings.QueueRetentionDays));
            if (evicted > 0) _log.LogWarning("dropped {Count} messages older than the retention", evicted);
            await RenewIfDueAsync(store, link, ct).ConfigureAwait(false);
        }
        while (await timer.WaitForNextTickAsync(ct).ConfigureAwait(false));
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
