using Hotella.Agent.Core.Connectors;
using Hotella.Agent.Core.Security;
using Microsoft.Extensions.Configuration;

namespace Hotella.Agent.Fias;

/// <summary>OPERA5_FIAS for the agent's connector registry: the IFC8 session (ADR-0019, Planova Standard FIAS profile).</summary>
public sealed class FiasConnector : IConnectorFactory
{
    public string Code => FiasAdapter.ConnectorCode;

    public static FiasSettings Settings(IConfiguration configuration)
    {
        var settings = new FiasSettings();
        configuration.GetSection(FiasSettings.Section).Bind(settings);
        return settings;
    }

    public IReadOnlyList<string> Problems(IConfiguration configuration) => Settings(configuration).Problems();

    public IReadOnlyList<string> Describe(IConfiguration configuration, SecretStore secrets, ICollection<string> problems)
    {
        var s = Settings(configuration);
        return [$"ifc8:         {s.Mode} {s.Host}:{s.Port} ({s.Encoding})"];
    }

    public IConnectorAdapter Create(ConnectorContext context) =>
        new FiasAdapter(Settings(context.Configuration), context.InstanceId, context.Loggers.CreateLogger("hotella.fias"));
}
