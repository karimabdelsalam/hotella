using System.Security.Cryptography.X509Certificates;

namespace Hotella.Agent.Core.Hosting;

/// <summary>
/// The agent's configuration (section <c>Agent</c> of <c>agent.json</c>, environment <c>HOTELLA_AGENT_…</c>). It holds
/// no secret: the identity (device key and certificate) lives in the protected data directory.
/// </summary>
public sealed class AgentSettings
{
    public const string Section = "Agent";

    /// <summary>The platform's agent gateway, e.g. <c>https://agents.hotella.example</c> (outbound HTTPS only).</summary>
    public Uri? Gateway { get; set; }

    /// <summary>The connector this agent serves (from the integration's connector manifest), e.g. <c>OPERA5_FIAS</c>.</summary>
    public string ConnectorCode { get; set; } = "";

    /// <summary>Capabilities this agent serves; the platform uses the intersection with what the hotel enabled.</summary>
    public IList<string> Capabilities { get; } = [];

    /// <summary>Identity and queue; defaults to the OS location for service data.</summary>
    public string DataDirectory { get; set; } = DefaultDataDirectory();

    /// <summary>How long acknowledged-but-unsent history is kept at most (buffered messages are never dropped earlier).</summary>
    public int QueueRetentionDays { get; set; } = 14;

    /// <summary>Renew the device certificate once less than this share of its lifetime remains.</summary>
    public double RenewAtRemainingFraction { get; set; } = 1.0 / 3;

    public static string DefaultDataDirectory() =>
        OperatingSystem.IsWindows()
            ? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData), "Hotella", "Agent")
            : "/var/lib/hotella-agent";

    /// <summary>What is wrong with the settings, in words an installer can act on (empty when usable).</summary>
    public IReadOnlyList<string> Problems()
    {
        var problems = new List<string>();
        if (Gateway is null) problems.Add("Agent:Gateway is not set");
        else if (Gateway.Scheme != Uri.UriSchemeHttps) problems.Add("Agent:Gateway must be an https:// address");
        if (string.IsNullOrWhiteSpace(ConnectorCode)) problems.Add("Agent:ConnectorCode is not set");
        if (Capabilities.Count == 0) problems.Add("Agent:Capabilities is empty");
        if (QueueRetentionDays < 1) problems.Add("Agent:QueueRetentionDays must be at least 1");
        if (RenewAtRemainingFraction is <= 0 or >= 1) problems.Add("Agent:RenewAtRemainingFraction must be between 0 and 1");
        return problems;
    }
}

/// <summary>When the device certificate is renewed (deterministic; ADR-0017 §2: short-lived certificates).</summary>
public static class RenewalPolicy
{
    public static (DateTimeOffset notBefore, DateTimeOffset notAfter) Validity(string certificatePem)
    {
        using var certificate = X509Certificate2.CreateFromPem(certificatePem);
        return (new DateTimeOffset(certificate.NotBefore.ToUniversalTime(), TimeSpan.Zero),
            new DateTimeOffset(certificate.NotAfter.ToUniversalTime(), TimeSpan.Zero));
    }

    /// <summary>Due once the remaining lifetime falls below the fraction (an expired certificate is due too).</summary>
    public static bool IsDue(DateTimeOffset notBefore, DateTimeOffset notAfter, DateTimeOffset now, double remainingFraction)
    {
        var lifetime = notAfter - notBefore;
        if (lifetime <= TimeSpan.Zero) return true;
        return notAfter - now <= lifetime * remainingFraction;
    }
}
