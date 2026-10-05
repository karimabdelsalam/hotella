using Hotella.Agent.Core.Hosting;
using Hotella.Agent.Core.Link;
using Hotella.Agent.Core.Security;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging;

namespace Hotella.Agent.Core.Connectors;

/// <summary>
/// Connector SDK v2 (ADR-0024): everything the agent needs from a connector. It reads the hotel system and publishes
/// raw vendor messages into the link (which queues them durably), serves the predefined commands and reads of its
/// manifest, and reports its own health. The agent host never names a connector: it asks the registry.
/// </summary>
public interface IConnectorAdapter : IAdapterHealth, IDisposable
{
    /// <summary>Handlers for the manifest's predefined commands (none for a read-only connector).</summary>
    IReadOnlyList<ICommandHandler> Commands();

    /// <summary>Handlers for the manifest's predefined reads (link protocol 2; none for an event-only connector).</summary>
    IReadOnlyList<IQueryHandler> Queries();

    /// <summary>Reads the hotel system until stopped; keeps reading while the platform is unreachable.</summary>
    Task RunAsync(IMessagePublisher publisher, CancellationToken ct);
}

/// <summary>What the host hands a connector when it starts one.</summary>
public sealed record ConnectorContext(
    IConfiguration Configuration,
    string InstanceId,
    string DataDirectory,
    SecretStore Secrets,
    ILoggerFactory Loggers);

/// <summary>One connector the agent can run: its settings checks, its status lines and how to start it.</summary>
public interface IConnectorFactory
{
    /// <summary>The connector code of the platform's manifest (e.g. <c>OPERA5_FIAS</c>).</summary>
    string Code { get; }

    /// <summary>Problems in the connector's settings that stop the agent from starting (none when it can run).</summary>
    IReadOnlyList<string> Problems(IConfiguration configuration);

    /// <summary>
    /// What <c>hotella-agent status</c> shows for this connector (no secret values), adding the problems only visible
    /// at the site, such as a secret that is not set.
    /// </summary>
    IReadOnlyList<string> Describe(IConfiguration configuration, SecretStore secrets, ICollection<string> problems);

    IConnectorAdapter Create(ConnectorContext context);
}

/// <summary>The connectors compiled into this agent, by code (replaces selection by hard-coded connector codes).</summary>
public sealed class ConnectorAdapterRegistry
{
    private readonly Dictionary<string, IConnectorFactory> _factories = new(StringComparer.Ordinal);

    public ConnectorAdapterRegistry(IEnumerable<IConnectorFactory> factories)
    {
        foreach (var f in factories)
            if (!_factories.TryAdd(f.Code, f))
                throw new ArgumentException($"connector {f.Code} is registered twice", nameof(factories));
    }

    public IReadOnlyCollection<string> Codes => _factories.Keys;

    public IConnectorFactory? Find(string? code) =>
        code is not null && _factories.TryGetValue(code, out var f) ? f : null;

    /// <summary>
    /// The connector's settings problems. A code without an adapter here runs the link alone (simulators and
    /// conformance: commands the agent cannot serve are answered as failed), so it is not a problem.
    /// </summary>
    public IReadOnlyList<string> Problems(string? code, IConfiguration configuration) =>
        Find(code)?.Problems(configuration) ?? [];
}
