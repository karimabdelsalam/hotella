using Hotella.Agent.Core.Connectors;
using Hotella.Agent.Core.Security;
using Microsoft.Extensions.Configuration;

namespace Hotella.Agent.Ows;

/// <summary>OPERA5_OWS for the agent's connector registry: the OWS poller, standard reads and the contact write.</summary>
public sealed class OwsConnector : IConnectorFactory
{
    public string Code => OwsAdapter.ConnectorCode;

    public static OwsSettings Settings(IConfiguration configuration)
    {
        var settings = new OwsSettings();
        configuration.GetSection(OwsSettings.Section).Bind(settings);
        return settings;
    }

    public IReadOnlyList<string> Problems(IConfiguration configuration) => Settings(configuration).Problems();

    public IReadOnlyList<string> Describe(IConfiguration configuration, SecretStore secrets, ICollection<string> problems)
    {
        ArgumentNullException.ThrowIfNull(secrets);
        ArgumentNullException.ThrowIfNull(problems);
        var s = Settings(configuration);
        if (secrets.Get(s.PasswordSecret) is null) problems.Add($"secret {s.PasswordSecret} is not set");
        return [$"ows:          {s.Url} as {s.Username}, every {s.PollSeconds} s, {s.WindowDays} days ahead"];
    }

    public IConnectorAdapter Create(ConnectorContext context)
    {
        ArgumentNullException.ThrowIfNull(context);
        var s = Settings(context.Configuration);
        var secrets = context.Secrets;
        return new OwsAdapter(s, context.InstanceId, () => secrets.Get(s.PasswordSecret),
            Path.Combine(context.DataDirectory, "ows.db"), context.Loggers.CreateLogger("hotella.ows"));
    }
}
