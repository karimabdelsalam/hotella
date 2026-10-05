using Hotella.Agent.Core.Connectors;
using Hotella.Agent.Core.Hosting;
using Hotella.Agent.Core.Link;
using Hotella.Agent.Core.Security;
using Hotella.Agent.Fias;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging.Abstractions;

namespace Hotella.Agent.Tests;

public class ConnectorRegistryTests
{
    private static IConfiguration Config(params (string Key, string Value)[] values) =>
        new ConfigurationBuilder()
            .AddInMemoryCollection(values.ToDictionary(v => v.Key, v => (string?)v.Value))
            .Build();

    private static AgentSettings Agent(string code)
    {
        var settings = new AgentSettings { Gateway = new Uri("https://agents.example"), ConnectorCode = code };
        settings.Capabilities.Add("CHECKIN_EVENT");
        return settings;
    }

    [Fact]
    public void The_agent_serves_the_three_OPERA_connectors_through_the_registry()
    {
        Assert.Equal(["OPERA5_DB", "OPERA5_FIAS", "OPERA5_OWS"], AgentHost.Connectors.Codes.Order(StringComparer.Ordinal));
        Assert.IsType<FiasConnector>(AgentHost.Connectors.Find("OPERA5_FIAS"));
        Assert.Null(AgentHost.Connectors.Find("SIM_PMS"));
        Assert.Null(AgentHost.Connectors.Find(null));
    }

    [Fact]
    public void A_code_without_an_adapter_runs_the_link_alone()
    {
        Assert.Empty(AgentHost.Problems(Agent("SIM_PMS"), Config()));
    }

    [Fact]
    public void The_connector_checks_its_own_section()
    {
        Assert.Contains("Fias:Host is not set", AgentHost.Problems(Agent("OPERA5_FIAS"), Config()));
        Assert.Empty(AgentHost.Problems(Agent("OPERA5_FIAS"), Config(("Fias:Host", "ifc8"), ("Fias:Port", "5010"))));
    }

    [Fact]
    public void Status_lines_add_site_problems_such_as_a_missing_secret_without_printing_values()
    {
        var dir = Directory.CreateTempSubdirectory().FullName;
        try
        {
            var config = Config(("Ows:Url", "https://ows.example/"), ("Ows:Username", "hotella"), ("Ows:HotelCode", "H1"));
            var problems = new List<string>();
            var lines = AgentHost.Connectors.Find("OPERA5_OWS")!.Describe(config, new SecretStore(dir), problems);
            Assert.Single(lines);
            Assert.StartsWith("ows:          https://ows.example/ as hotella", lines[0]);
            Assert.Single(problems);
            Assert.StartsWith("secret ", problems[0]);
        }
        finally
        {
            Directory.Delete(dir, recursive: true);
        }
    }

    [Fact]
    public void A_factory_starts_an_adapter_that_the_link_and_health_see_only_through_the_interface()
    {
        var dir = Directory.CreateTempSubdirectory().FullName;
        try
        {
            using var adapter = AgentHost.Connectors.Find("OPERA5_FIAS")!.Create(new ConnectorContext(
                Config(("Fias:Host", "ifc8"), ("Fias:Port", "5010")), "instance-a", dir, new SecretStore(dir),
                NullLoggerFactory.Instance));
            Assert.Equal(["RESYNC_IN_HOUSE", "SET_ROOM_STATUS"], adapter.Commands().Select(c => c.CommandType).Order());
            Assert.Empty(adapter.Queries());
            IAdapterHealth health = adapter;
            Assert.False(health.Up);
            Assert.Equal("IFC8 link down", health.Problem);
        }
        finally
        {
            Directory.Delete(dir, recursive: true);
        }
    }

    [Fact]
    public void A_connector_registered_twice_is_refused()
    {
        Assert.Throws<ArgumentException>(() => new ConnectorAdapterRegistry([new FiasConnector(), new FiasConnector()]));
    }
}
