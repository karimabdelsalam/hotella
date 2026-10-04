using Hotella.Agent.Core.Hosting;
using Hotella.Agent.Fias;
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

    /// <summary>Settings problems of the agent and of the adapter its connector needs.</summary>
    public static List<string> Problems(AgentSettings agent, FiasSettings fias)
    {
        var problems = agent.Problems().ToList();
        if (agent.ConnectorCode == FiasAdapter.ConnectorCode) problems.AddRange(fias.Problems());
        return problems;
    }

    public static async Task<int> RunAsync(string[] args)
    {
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
        builder.Services.AddHostedService<AgentWorker>();
        using var host = builder.Build();
        await host.RunAsync().ConfigureAwait(false);
        return Environment.ExitCode;
    }
}
