using Hotella.Agent.Core.Hosting;
using Hotella.Agent.Core.Security;
using Hotella.Agent.Fias;
using Hotella.Agent.OperaDb;
using Hotella.Agent.Ows;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;

namespace Hotella.Agent;

/// <summary>Configuration sources and the generic host (Windows service or systemd unit, or the foreground).</summary>
internal static class AgentHost
{
    public const string ServiceName = "HotellaAgent";

    /// <summary>
    /// Settings, lowest precedence first: <c>agent.json</c> beside the program, the machine's <c>agent.json</c>
    /// (<c>/etc/hotella-agent</c> or <c>%ProgramData%\Hotella\Agent</c>), <c>HOTELLA_AGENT_</c> environment variables,
    /// then <c>--Agent:Key=value</c> switches.
    /// </summary>
    public static void AddSources(IConfigurationBuilder config, string[] args)
    {
        config.AddJsonFile(Path.Combine(AppContext.BaseDirectory, "agent.json"), optional: true);
        if (Instance(args) is { } instance)
        {
            // One of several agents on this host (ADR-0020): its own settings, identity and queue.
            var dir = InstanceDirectory(instance, DataRoot(args));
            config.AddInMemoryCollection(new Dictionary<string, string?> { ["Agent:DataDirectory"] = dir });
            config.AddJsonFile(Path.Combine(dir, "agent.json"), optional: true);
        }
        else config.AddJsonFile(MachineConfigFile(), optional: true);
        config.AddEnvironmentVariables("HOTELLA_AGENT_");
        config.AddCommandLine(WithoutHostOptions(args));
    }

    /// <summary>Host options (with their values) are not settings: <c>--instance</c>, <c>--data-root</c>.</summary>
    private static string[] WithoutHostOptions(string[] args) =>
        args.Where((a, i) => a is not ("--instance" or "--data-root")
            && (i == 0 || args[i - 1] is not ("--instance" or "--data-root"))).ToArray();

    /// <summary>
    /// The host's data root: <c>%ProgramData%\Hotella\Agent</c> or <c>/var/lib/hotella-agent</c>, or
    /// <c>--data-root &lt;dir&gt;</c> (development and tests).
    /// </summary>
    public static string DataRoot(string[] args)
    {
        var i = Array.IndexOf(args, "--data-root");
        return i >= 0 && i + 1 < args.Length ? Path.GetFullPath(args[i + 1]) : AgentSettings.DefaultDataDirectory();
    }

    /// <summary>The <c>--instance &lt;name&gt;</c> of a multi-agent host, validated (null when absent).</summary>
    public static string? Instance(string[] args)
    {
        var i = Array.IndexOf(args, "--instance");
        if (i < 0) return null;
        var name = i + 1 < args.Length ? args[i + 1] : "";
        return IsInstanceName(name) ? name : throw new ArgumentException($"invalid instance name '{name}'");
    }

    public static bool IsInstanceName(string name) =>
        name.Length is >= 1 and <= 32 && name.All(c => char.IsAsciiLetterLower(c) || char.IsAsciiDigit(c) || c == '-')
        && char.IsAsciiLetterOrDigit(name[0]);

    public static string InstanceDirectory(string name, string? dataRoot = null) =>
        Path.Combine(dataRoot ?? AgentSettings.DefaultDataDirectory(), "instances", name);

    /// <summary>The Windows service / systemd unit of an instance (the single-instance service without one).</summary>
    public static string ServiceNameOf(string? instance) => instance is null ? ServiceName : $"{ServiceName}-{instance}";

    public static string MachineConfigFile() =>
        OperatingSystem.IsWindows()
            ? Path.Combine(AgentSettings.DefaultDataDirectory(), "agent.json")
            : "/etc/hotella-agent/agent.json";

    public static AgentSettings Settings(IConfiguration config)
    {
        var settings = new AgentSettings();
        config.GetSection(AgentSettings.Section).Bind(settings);
        return settings;
    }

    public static FiasSettings FiasSettings(IConfiguration config)
    {
        var settings = new FiasSettings();
        config.GetSection(Fias.FiasSettings.Section).Bind(settings);
        return settings;
    }

    public static OwsSettings OwsSettings(IConfiguration config)
    {
        var settings = new OwsSettings();
        config.GetSection(Ows.OwsSettings.Section).Bind(settings);
        return settings;
    }

    public static OperaDbSettings OperaDbSettings(IConfiguration config)
    {
        var settings = new OperaDbSettings();
        config.GetSection(OperaDb.OperaDbSettings.Section).Bind(settings);
        return settings;
    }

    /// <summary>Settings problems of the agent and of the adapter its connector needs.</summary>
    public static List<string> Problems(AgentSettings agent, FiasSettings fias, OwsSettings ows, OperaDbSettings db)
    {
        var problems = agent.Problems().ToList();
        if (agent.ConnectorCode == FiasAdapter.ConnectorCode) problems.AddRange(fias.Problems());
        if (agent.ConnectorCode == OwsAdapter.ConnectorCode) problems.AddRange(ows.Problems());
        if (agent.ConnectorCode == OperaDbAdapter.ConnectorCode) problems.AddRange(db.Problems());
        return problems;
    }

    /// <summary>The OPERA database the settings name: the hotel's Oracle, or the fixture file (development and CI).</summary>
    public static IOperaDataSource OperaDataSource(OperaDbSettings db, SecretStore secrets) =>
        db.Provider == "fixture"
            ? new FixtureDataSource(db.FixturePath!, db.ResortCode)
            : new OracleDataSource(db, secrets.Get(db.PasswordSecret)
                ?? throw new InvalidOperationException(
                    $"the OPERA database password is not set (hotella-agent secret set {db.PasswordSecret})"));

    public static async Task<int> RunAsync(string[] args)
    {
        // A candidate that keeps failing to start goes back before anything else runs.
        var startup = new ConfigurationBuilder();
        AddSources(startup, args);
        if (UpdateSettings.From(startup.Build()).Updater() is { } updater
            && !updater.OnStartup(UpdateSettings.Running, DateTimeOffset.UtcNow))
            return ExitCodes.RolledBack;
        var builder = Host.CreateApplicationBuilder(new HostApplicationBuilderSettings
        {
            Args = args,
            ContentRootPath = AppContext.BaseDirectory,
            DisableDefaults = false,
        });
        builder.Configuration.Sources.Clear();
        AddSources(builder.Configuration, args);
        builder.Services.AddWindowsService(o => o.ServiceName = ServiceNameOf(Instance(args)));
        builder.Services.AddSystemd();
        builder.Services.AddSingleton(Settings(builder.Configuration));
        builder.Services.AddSingleton(FiasSettings(builder.Configuration));
        builder.Services.AddSingleton(OwsSettings(builder.Configuration));
        builder.Services.AddSingleton(OperaDbSettings(builder.Configuration));
        builder.Services.AddSingleton(UpdateSettings.From(builder.Configuration));
        builder.Services.AddHostedService<AgentWorker>();
        using var host = builder.Build();
        await host.RunAsync().ConfigureAwait(false);
        return Environment.ExitCode;
    }
}
