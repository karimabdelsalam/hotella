using System.Globalization;
using System.Reflection;
using Hotella.Agent.Core.Hosting;
using Hotella.Agent.Core.Queue;
using Hotella.Agent.Core.Security;
using Hotella.Agent.OperaDb;
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
                   hotella-agent opera-db probe              check the OPERA database account and data contract
                   hotella-agent setup install [--codes-file <file>]   layout, data directory, services (MSI / install.ps1)
                   hotella-agent setup remove [--remove-data] | setup stop
                   hotella-agent <command> --instance <name>   one of several agents on this host
                   hotella-agent <command> --data-root <dir>   another data root (development, tests)
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
        var settings = SettingsFrom(ConfigArgs(args));
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

    /// <summary>
    /// The installer's step (ADR-0020): <c>setup install</c> lays out the version, protects the data directory and
    /// creates one service per enrollment code found in <c>--codes-file</c> (read, then deleted); <c>setup remove</c>
    /// undoes it, keeping the identities unless <c>--remove-data</c>.
    /// </summary>
    public static async Task<int> SetupAsync(string[] args)
    {
        IServiceManager services = OperatingSystem.IsWindows() ? new WindowsServiceManager() : new NoServiceManager();
        var root = Option(args, "--data-root");
        var program = Environment.ProcessPath!;
        // Under `dotnet hotella-agent.dll` (development, tests) the program is the assembly, not the dotnet host.
        if (Path.GetFileNameWithoutExtension(program) == "dotnet") program = Path.Combine(AppContext.BaseDirectory, "hotella-agent");
        var setup = new Setup(services, AgentHost.DataRoot(args), program, Console.Out,
            instance =>
            {
                // Start only what can run: enrolled, and settings complete for its connector.
                string[] host = root is null ? [] : ["--data-root", root];
                var config = Config(instance is null ? host : ["--instance", instance, .. host]);
                var settings = AgentHost.Settings(config);
                return new IdentityStore(settings.DataDirectory).Exists
                    && AgentHost.Problems(settings, config).Count == 0;
            });
        switch (args.FirstOrDefault())
        {
            case "install":
                return await setup.InstallAsync(Option(args, "--codes-file"), async (code, ct) =>
                {
                    var ca = await code.FetchCaAsync(null, ct).ConfigureAwait(false);
                    return await Enrollment.EnrollWithProfileAsync(code.Gateway, code.Token, ca, AgentVersion, ct)
                        .ConfigureAwait(false);
                }, CancellationToken.None).ConfigureAwait(false);
            case "remove":
                return setup.Remove(args.Contains("--remove-data"));
            case "stop":
                return setup.Stop();
            default:
                return Usage();
        }
    }

    /// <summary>What a support engineer checks first. Exit 0 when the agent can run.</summary>
    public static int Status(string[] args)
    {
        var config = Config(args);
        var settings = AgentHost.Settings(config);
        var problems = AgentHost.Problems(settings, config);
        Console.WriteLine($"version:      {AgentVersion}");
        Console.WriteLine($"gateway:      {settings.Gateway}");
        Console.WriteLine($"connector:    {settings.ConnectorCode} [{string.Join(", ", settings.Capabilities)}]");
        Console.WriteLine($"data:         {settings.DataDirectory}");
        var secrets = new SecretStore(settings.DataDirectory);
        if (AgentHost.Connectors.Find(settings.ConnectorCode) is { } connector)
            foreach (var line in connector.Describe(config, secrets, problems)) Console.WriteLine(line);
        else if (!string.IsNullOrWhiteSpace(settings.ConnectorCode))
            Console.WriteLine("adapter:      none in this agent (link only)");
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
    /// Commissioning check of the OPERA database connector (guide §16.4): the account's privileges against the
    /// read-only rule, the data contract's objects and columns in the hotel's schema, and row counts for the resort.
    /// Prints no personal data. Exit 0 only when everything is in order.
    /// </summary>
    public static async Task<int> OperaDbAsync(string[] args)
    {
        if (args.FirstOrDefault() != "probe") return Usage();
        var config = Config(args.Skip(1).ToArray());
        var settings = AgentHost.Settings(config);
        var db = OperaDbConnector.Settings(config);
        var problems = db.Problems().ToList();
        if (problems.Count > 0)
        {
            foreach (var p in problems) Console.WriteLine($"problem:      {p}");
            return ExitCodes.NotConfigured;
        }
        using var source = OperaDbConnector.DataSource(db, new SecretStore(settings.DataDirectory));
        Console.WriteLine($"contract:     data contract v{DataContract.Version}, owner {db.SchemaOwner}, resort {db.ResortCode}");
        var privileges = PrivilegeCheck.Problems(await source.PrivilegesAsync(CancellationToken.None).ConfigureAwait(false), db.SchemaOwner);
        Console.WriteLine(privileges.Count == 0 ? "privileges:   read-only (CREATE SESSION + SELECT on the contract)" : "privileges:   NOT read-only");
        problems.AddRange(privileges);
        var probe = await source.ProbeAsync(CancellationToken.None).ConfigureAwait(false);
        foreach (var o in probe.MissingObjects) problems.Add($"contract object {db.SchemaOwner}.{o} not found");
        foreach (var c in probe.MissingColumns) problems.Add($"contract column {c} not found");
        foreach (var (table, count) in probe.Counts) Console.WriteLine($"rows:         {table} {count} for the resort");
        foreach (var p in problems) Console.WriteLine($"problem:      {p}");
        return problems.Count == 0 ? ExitCodes.Ok : ExitCodes.Refused;
    }

    /// <summary>
    /// Credentials the adapters need at the hotel, read from stdin (never from the command line) and kept in the
    /// protected store; values are never printed.
    /// </summary>
    public static async Task<int> SecretAsync(string[] args)
    {
        var store = new SecretStore(SettingsFrom(ConfigArgs(args))
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

    /// <summary>The settings switches of a command line, and its <c>--instance</c>.</summary>
    private static string[] ConfigArgs(string[] args)
    {
        var instance = AgentHost.Instance(args);
        var root = Option(args, "--data-root");
        return [.. args.Where(a => a.StartsWith("--Agent:", StringComparison.Ordinal)),
            .. instance is null ? Array.Empty<string>() : ["--instance", instance],
            .. root is null ? Array.Empty<string>() : ["--data-root", root]];
    }

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
