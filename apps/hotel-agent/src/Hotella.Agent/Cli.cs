using System.Globalization;
using System.Reflection;
using Hotella.Agent.Core.Hosting;
using Hotella.Agent.Core.Queue;
using Hotella.Agent.Core.Security;
using Hotella.Agent.Fias;
using Microsoft.Extensions.Configuration;

namespace Hotella.Agent;

/// <summary>The installer's and the operator's commands. Plain output; nothing secret is ever printed.</summary>
internal static class Cli
{
    public static string AgentVersion { get; } =
        typeof(Cli).Assembly.GetCustomAttribute<AssemblyInformationalVersionAttribute>()?.InformationalVersion
            .Split('+')[0] ?? "0.0.0";

    public static int Usage()
    {
        Console.Error.WriteLine("""
            usage: hotella-agent [run]                       run the link (as a service or in the foreground)
                   hotella-agent enroll --token-file <file|-> --ca <file> [--replace] [--Agent:Gateway=<url>]
                   hotella-agent status                      identity, certificate and queue
                   hotella-agent version
            """);
        return ExitCodes.Usage;
    }

    public static int Version()
    {
        Console.WriteLine(AgentVersion);
        return ExitCodes.Ok;
    }

    /// <summary>
    /// One-time enrollment with the single-use token from the platform (ADR-0017 §2). The token is read from a file or
    /// stdin, never from the command line (it would land in the shell history and the process list).
    /// </summary>
    public static async Task<int> EnrollAsync(string[] args)
    {
        var tokenFile = Option(args, "--token-file");
        var caFile = Option(args, "--ca");
        if (tokenFile is null || caFile is null) return Usage();
        var settings = SettingsFrom(args.Where(a => a.StartsWith("--Agent:", StringComparison.Ordinal)).ToArray());
        if (settings.Gateway is null || settings.Gateway.Scheme != Uri.UriSchemeHttps)
        {
            Console.Error.WriteLine("Agent:Gateway must be set to the platform's https:// agent gateway");
            return ExitCodes.NotConfigured;
        }
        var store = new IdentityStore(settings.DataDirectory);
        if (store.Exists && !args.Contains("--replace"))
        {
            Console.Error.WriteLine("this agent is already enrolled; add --replace to enroll it again (e.g. after a revocation)");
            return ExitCodes.Usage;
        }
        var token = (tokenFile == "-" ? await Console.In.ReadLineAsync().ConfigureAwait(false)
            : await File.ReadAllTextAsync(tokenFile).ConfigureAwait(false))?.Trim();
        if (string.IsNullOrEmpty(token)) return Usage();
        var ca = await File.ReadAllTextAsync(caFile).ConfigureAwait(false);
        try
        {
            var identity = await Enrollment.EnrollAsync(settings.Gateway, token, ca, AgentVersion, CancellationToken.None)
                .ConfigureAwait(false);
            store.Save(identity);
            var (_, notAfter) = RenewalPolicy.Validity(identity.CertificatePem);
            Console.WriteLine(string.Create(CultureInfo.InvariantCulture,
                $"enrolled as instance {identity.InstanceId}; certificate valid until {notAfter:u}"));
            return ExitCodes.Ok;
        }
        catch (GatewayHttpException e)
        {
            Console.Error.WriteLine($"enrollment refused: {e.Code} (HTTP {e.Status}); ask for a new token");
            return ExitCodes.Refused;
        }
    }

    /// <summary>What a support engineer checks first. Exit 0 when the agent can run.</summary>
    public static int Status(string[] args)
    {
        var config = Config(args);
        var settings = AgentHost.Settings(config);
        var fias = AgentHost.FiasSettings(config);
        var problems = AgentHost.Problems(settings, fias);
        Console.WriteLine($"version:      {AgentVersion}");
        Console.WriteLine($"gateway:      {settings.Gateway}");
        Console.WriteLine($"connector:    {settings.ConnectorCode} [{string.Join(", ", settings.Capabilities)}]");
        Console.WriteLine($"data:         {settings.DataDirectory}");
        if (settings.ConnectorCode == FiasAdapter.ConnectorCode)
            Console.WriteLine($"ifc8:         {fias.Mode} {fias.Host}:{fias.Port} ({fias.Encoding})");
        var identity = new IdentityStore(settings.DataDirectory).Load();
        if (identity is null) problems.Add("not enrolled");
        else
        {
            var (notBefore, notAfter) = RenewalPolicy.Validity(identity.CertificatePem);
            var now = DateTimeOffset.UtcNow;
            Console.WriteLine($"instance:     {identity.InstanceId}");
            var due = RenewalPolicy.IsDue(notBefore, notAfter, now, settings.RenewAtRemainingFraction);
            Console.WriteLine("certificate:  valid until " + notAfter.ToString("u", CultureInfo.InvariantCulture)
                + (due ? " (renewal due)" : ""));
            if (notAfter <= now) problems.Add("certificate expired: the agent must be enrolled again");
        }
        var queueFile = Path.Combine(settings.DataDirectory, "queue.db");
        if (File.Exists(queueFile))
        {
            using var queue = DurableOutbox.Open(queueFile);
            Console.WriteLine($"queue:        {queue.Depth} waiting" + (queue.FirstBuffered is { } first ? $" from #{first}" : ""));
        }
        foreach (var p in problems) Console.WriteLine($"problem:      {p}");
        return problems.Count == 0 ? ExitCodes.Ok : ExitCodes.NotConfigured;
    }

    private static AgentSettings SettingsFrom(string[] args) => AgentHost.Settings(Config(args));

    private static IConfiguration Config(string[] args)
    {
        var config = new ConfigurationBuilder();
        AgentHost.AddSources(config, args);
        return config.Build();
    }

    private static string? Option(string[] args, string name)
    {
        var i = Array.IndexOf(args, name);
        return i >= 0 && i + 1 < args.Length ? args[i + 1] : null;
    }
}
