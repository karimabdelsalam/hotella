using Hotella.Agent.Core.Connectors;
using Hotella.Agent.Core.Hosting;
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

    /// <summary>
    /// The connectors compiled into this agent (Connector SDK v2, ADR-0024). A new connector is a project with an
    /// <see cref="IConnectorFactory"/> added here; nothing else in the host names a connector.
    /// </summary>
    public static readonly ConnectorAdapterRegistry Connectors =
        new([new FiasConnector(), new OwsConnector(), new OperaDbConnector()]);

    /// <summary>Settings problems of the agent and of the connector it runs.</summary>
    public static List<string> Problems(AgentSettings agent, IConfiguration config)
    {
        ArgumentNullException.ThrowIfNull(agent);
        return [.. agent.Problems(), .. Connectors.Problems(agent.ConnectorCode, config)];
    }

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
        builder.Services.AddSingleton(Connectors);
        builder.Services.AddSingleton(UpdateSettings.From(builder.Configuration));
        builder.Services.AddHostedService<AgentWorker>();
        using var host = builder.Build();
        await host.RunAsync().ConfigureAwait(false);
        return Environment.ExitCode;
    }
}
