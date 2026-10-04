using System.Globalization;
using System.Reflection;
using Hotella.Agent.Core.Hosting;
using Hotella.Agent.Core.Queue;
using Hotella.Agent.Core.Security;
using Hotella.Agent.Fias;
using Hotella.Agent.Ows;
using Hotella.Agent.Updater;
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
                   hotella-agent secret set <name>           store a credential read from stdin (e.g. ows.password)
                   hotella-agent secret list|remove <name>
                   hotella-agent update status|check|apply|rollback
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
        var ows = AgentHost.OwsSettings(config);
        var problems = AgentHost.Problems(settings, fias, ows);
        Console.WriteLine($"version:      {AgentVersion}");
        Console.WriteLine($"gateway:      {settings.Gateway}");
        Console.WriteLine($"connector:    {settings.ConnectorCode} [{string.Join(", ", settings.Capabilities)}]");
        Console.WriteLine($"data:         {settings.DataDirectory}");
        if (settings.ConnectorCode == FiasAdapter.ConnectorCode)
            Console.WriteLine($"ifc8:         {fias.Mode} {fias.Host}:{fias.Port} ({fias.Encoding})");
        var secrets = new SecretStore(settings.DataDirectory);
        if (settings.ConnectorCode == OwsAdapter.ConnectorCode)
        {
            Console.WriteLine($"ows:          {ows.Url} as {ows.Username}, every {ows.PollSeconds} s, {ows.WindowDays} days ahead");
            if (secrets.Get(ows.PasswordSecret) is null) problems.Add($"secret {ows.PasswordSecret} is not set");
        }
        Console.WriteLine($"secrets:      {string.Join(", ", secrets.Names())}");
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
        if (identity is not null)
        {
            var licence = new Core.Licensing.LicenceStore(settings.DataDirectory,
                new CommandSignature(identity.CommandPublicKeyPem), identity.InstanceId);
            var state = licence.StateAt(DateTimeOffset.UtcNow);
            Console.WriteLine("licence:      " + state.ToString().ToUpperInvariant()
                + (licence.Current is { } l ? " until " + l.ExpiresAt.ToString("u", CultureInfo.InvariantCulture)
                    + $" (+{l.GraceDays} days grace)" : ""));
        }
        var healthFile = Path.Combine(settings.DataDirectory, "health.json");
        if (File.Exists(healthFile) && System.Text.Json.Nodes.JsonNode.Parse(File.ReadAllText(healthFile)) is { } health)
            Console.WriteLine($"health:       {health["status"]} at {health["at"]}"
                + string.Concat((health["reasons"]?.AsArray() ?? []).Select(r => $"\n              - {r}")));
        var queueFile = Path.Combine(settings.DataDirectory, "queue.db");
        if (File.Exists(queueFile))
        {
            using var queue = DurableOutbox.Open(queueFile);
            Console.WriteLine($"queue:        {queue.Depth} waiting" + (queue.FirstBuffered is { } first ? $" from #{first}" : ""));
        }
        foreach (var p in problems) Console.WriteLine($"problem:      {p}");
        return problems.Count == 0 ? ExitCodes.Ok : ExitCodes.NotConfigured;
    }

    /// <summary>
    /// Credentials the adapters need at the hotel, read from stdin (never from the command line) and kept in the
    /// protected store; values are never printed.
    /// </summary>
    public static async Task<int> SecretAsync(string[] args)
    {
        var store = new SecretStore(SettingsFrom(args.Where(a => a.StartsWith("--Agent:", StringComparison.Ordinal)).ToArray())
            .DataDirectory);
        switch (args.FirstOrDefault())
        {
            case "set" when args.Length >= 2:
                var value = (await Console.In.ReadLineAsync().ConfigureAwait(false))?.TrimEnd('\r', '\n');
                if (string.IsNullOrEmpty(value)) return Usage();
                store.Set(args[1], value);
                Console.WriteLine($"secret {args[1]} stored");
                return ExitCodes.Ok;
            case "remove" when args.Length >= 2:
                Console.WriteLine(store.Remove(args[1]) ? $"secret {args[1]} removed" : $"no secret {args[1]}");
                return ExitCodes.Ok;
            case "list":
                foreach (var name in store.Names()) Console.WriteLine(name);
                return ExitCodes.Ok;
            default:
                return Usage();
        }
    }

    /// <summary>The operator's view of self-updates; `apply` stages and switches, the service restart runs it.</summary>
    public static async Task<int> UpdateAsync(string[] args)
    {
        var settings = UpdateSettings.From(Config(args.Skip(1).ToArray()));
        var updater = settings.Updater();
        if (updater is null)
        {
            Console.Error.WriteLine("updates are off: Updates:ManifestUrl and Updates:PublicKeyFile must be set, and the "
                + "agent must run from <root>/versions/<version>/");
            return ExitCodes.NotConfigured;
        }
        try
        {
            return await UpdateCommandAsync(args, settings, updater).ConfigureAwait(false);
        }
        catch (Exception e) when (e is InvalidDataException or HttpRequestException or IOException
                                    or System.Text.Json.JsonException or InvalidOperationException)
        {
            Console.Error.WriteLine($"update refused: {e.Message}");
            return ExitCodes.Refused;
        }
    }

    private static async Task<int> UpdateCommandAsync(string[] args, UpdateSettings settings, AgentUpdater updater)
    {
        switch (args.FirstOrDefault())
        {
            case "status":
                Console.WriteLine(AgentUpdater.Describe(updater.State));
                return ExitCodes.Ok;
            case "check" or "apply":
                var manifest = await updater.CheckAsync(settings.ManifestUrl!, UpdateSettings.Running, CancellationToken.None)
                    .ConfigureAwait(false);
                Console.WriteLine(manifest is null ? $"{AgentVersion} is current" : $"available: {manifest}");
                if (manifest is null || args[0] == "check") return ExitCodes.Ok;
                await updater.StageAsync(manifest, CancellationToken.None).ConfigureAwait(false);
                updater.Switch(manifest.Version, UpdateSettings.Running, DateTimeOffset.UtcNow);
                Console.WriteLine($"switched to {manifest.Version}; restart the service to run it");
                return ExitCodes.Ok;
            case "rollback":
                updater.Rollback("rolled back by an operator");
                Console.WriteLine(AgentUpdater.Describe(updater.State) + "; restart the service to run it");
                return ExitCodes.Ok;
            default:
                return Usage();
        }
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
