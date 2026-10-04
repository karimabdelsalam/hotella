using System.Globalization;
using System.Text.Json.Nodes;
using Hotella.Agent.Core.Licensing;

namespace Hotella.Agent.Core.Hosting;

public enum HealthStatus
{
    Healthy,
    Degraded,
    Unhealthy,
}

/// <summary>What the agent knows about itself at one instant.</summary>
public sealed record HealthInputs(
    DateTimeOffset Now,
    bool LinkConnected,
    DateTimeOffset? LinkDownSince,
    bool? AdapterUp,
    string? AdapterProblem,
    LicenceState Licence,
    long QueueDepth,
    DateTimeOffset CertificateNotAfter);

/// <summary>A connector adapter's own view of the PMS side (IFC8 link, OWS polls).</summary>
public interface IAdapterHealth
{
    bool Up { get; }
    string? Problem { get; }
}

/// <summary>
/// The agent's health states (BUILD_PLAN §10 Phase 10, Spec §49): deterministic rules over the link, the PMS adapter,
/// the licence, the backlog and the certificate, each with the reason a support engineer acts on. Written to
/// <c>health.json</c> every minute for the service manager, <c>hotella-agent status</c> and the updater's probation.
/// </summary>
public static class AgentHealth
{
    public static readonly TimeSpan LinkDownUnhealthy = TimeSpan.FromMinutes(15);
    public const long BacklogDegraded = 1000;
    public static readonly TimeSpan CertificateWarning = TimeSpan.FromDays(7);

    public static (HealthStatus status, IReadOnlyList<string> reasons) Classify(HealthInputs h)
    {
        ArgumentNullException.ThrowIfNull(h);
        var unhealthy = new List<string>();
        var degraded = new List<string>();
        if (!h.LinkConnected)
        {
            if (h.LinkDownSince is { } since && h.Now - since >= LinkDownUnhealthy)
                unhealthy.Add("platform link down for more than 15 minutes (records are buffered)");
            else degraded.Add("platform link down (records are buffered)");
        }
        if (h.AdapterUp == false) degraded.Add("PMS side: " + (h.AdapterProblem ?? "not connected"));
        switch (h.Licence)
        {
            case LicenceState.Expired:
                unhealthy.Add("licence expired past its grace: commands are refused");
                break;
            case LicenceState.Grace:
                degraded.Add("licence expired, running on its offline grace");
                break;
            case LicenceState.Missing:
                degraded.Add("no licence received yet");
                break;
        }
        if (h.QueueDepth >= BacklogDegraded)
            degraded.Add(string.Create(CultureInfo.InvariantCulture, $"{h.QueueDepth} messages waiting to be sent"));
        if (h.CertificateNotAfter <= h.Now) unhealthy.Add("device certificate expired: enroll again");
        else if (h.CertificateNotAfter - h.Now <= CertificateWarning) degraded.Add("device certificate expires within 7 days");
        return unhealthy.Count > 0 ? (HealthStatus.Unhealthy, [.. unhealthy, .. degraded])
            : degraded.Count > 0 ? (HealthStatus.Degraded, degraded)
            : (HealthStatus.Healthy, []);
    }

    public static JsonObject Report(HealthInputs h, string version)
    {
        ArgumentNullException.ThrowIfNull(h);
        var (status, reasons) = Classify(h);
        return new JsonObject
        {
            ["status"] = status.ToString().ToUpperInvariant(),
            ["reasons"] = new JsonArray([.. reasons.Select(r => (JsonNode)r)]),
            ["at"] = h.Now.ToString("O", CultureInfo.InvariantCulture),
            ["version"] = version,
            ["link_connected"] = h.LinkConnected,
            ["adapter_up"] = h.AdapterUp,
            ["licence"] = h.Licence.ToString().ToUpperInvariant(),
            ["queue_depth"] = h.QueueDepth,
            ["certificate_not_after"] = h.CertificateNotAfter.ToString("O", CultureInfo.InvariantCulture),
        };
    }
}
