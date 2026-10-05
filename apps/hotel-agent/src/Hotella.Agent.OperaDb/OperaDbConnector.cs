using Hotella.Agent.Core.Connectors;
using Hotella.Agent.Core.Security;
using Microsoft.Extensions.Configuration;

namespace Hotella.Agent.OperaDb;

/// <summary>OPERA5_DB for the agent's connector registry: read-only reads of the OPERA database (never written).</summary>
public sealed class OperaDbConnector : IConnectorFactory
{
    public string Code => OperaDbAdapter.ConnectorCode;

    public static OperaDbSettings Settings(IConfiguration configuration)
    {
        var settings = new OperaDbSettings();
        configuration.GetSection(OperaDbSettings.Section).Bind(settings);
        return settings;
    }

    /// <summary>The OPERA database the settings name: the hotel's Oracle, or the fixture file (development and CI).</summary>
    public static IOperaDataSource DataSource(OperaDbSettings db, SecretStore secrets)
    {
        ArgumentNullException.ThrowIfNull(db);
        ArgumentNullException.ThrowIfNull(secrets);
        return db.Provider == "fixture"
            ? new FixtureDataSource(db.FixturePath!, db.ResortCode)
            : new OracleDataSource(db, secrets.Get(db.PasswordSecret)
                ?? throw new InvalidOperationException(
                    $"the OPERA database password is not set (hotella-agent secret set {db.PasswordSecret})"));
    }

    public IReadOnlyList<string> Problems(IConfiguration configuration) => Settings(configuration).Problems();

    public IReadOnlyList<string> Describe(IConfiguration configuration, SecretStore secrets, ICollection<string> problems)
    {
        ArgumentNullException.ThrowIfNull(secrets);
        ArgumentNullException.ThrowIfNull(problems);
        var db = Settings(configuration);
        if (db.Provider == "oracle" && secrets.Get(db.PasswordSecret) is null)
            problems.Add($"secret {db.PasswordSecret} is not set");
        return
        [
            $"opera-db:     {db.Provider} {db.Host}:{db.Port}/{db.ServiceName} as {db.Username}, owner {db.SchemaOwner}, resort {db.ResortCode}"
                + (db.ChangePolling ? $", change polling every {db.PollSeconds} s" : ""),
        ];
    }

    public IConnectorAdapter Create(ConnectorContext context)
    {
        ArgumentNullException.ThrowIfNull(context);
        var db = Settings(context.Configuration);
        return new OperaDbAdapter(db, context.InstanceId, DataSource(db, context.Secrets),
            Path.Combine(context.DataDirectory, "opera-db.db"), context.Loggers.CreateLogger("hotella.opera-db"));
    }
}
