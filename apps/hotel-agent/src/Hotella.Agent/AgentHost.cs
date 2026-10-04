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
        config.AddJsonFile(MachineConfigFile(), optional: true);
        config.AddEnvironmentVariables("HOTELLA_AGENT_");
        config.AddCommandLine(args);
    }

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
        builder.Services.AddWindowsService(o => o.ServiceName = ServiceName);
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
