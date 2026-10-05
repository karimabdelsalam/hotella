using System.Net;
using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Hotella.Agent.Core.Security;

namespace Hotella.Agent.Tests;

public sealed class SetupTests : IDisposable
{
    private readonly string _dir = Directory.CreateTempSubdirectory("hotella-setup-").FullName;

    private static string Code(string gateway, string token, string fingerprint) =>
        EnrollmentCode.Prefix + Convert.ToBase64String(Encoding.UTF8.GetBytes(
            JsonSerializer.Serialize(new { g = gateway, t = token, c = fingerprint })))
            .TrimEnd('=').Replace('+', '-').Replace('/', '_');

    private static string SelfSignedCa()
    {
        using var key = ECDsa.Create(ECCurve.NamedCurves.nistP256);
        var request = new CertificateRequest("CN=Test Agent CA", key, HashAlgorithmName.SHA256);
        using var cert = request.CreateSelfSigned(DateTimeOffset.UtcNow.AddDays(-1), DateTimeOffset.UtcNow.AddDays(30));
        return cert.ExportCertificatePem();
    }

    [Fact]
    public void Enrollment_codes_are_found_in_any_text_and_checked()
    {
        var fp = new string('a', 64);
        var a = Code("https://agents.example.com:8443", "hat_token_one_0123456789", fp);
        var b = Code("https://agents.example.com:8443", "hat_token_two_0123456789", fp);
        // As the MSI writes them (an .ini) or as a plain list.
        var found = EnrollmentCode.FindAll($"[Enrollment]\r\nCode1={a}\r\nCode2=\r\nCode3=\"{b}\"\r\n");
        Assert.Equal(["hat_token_one_0123456789", "hat_token_two_0123456789"], found.Select(c => c.Token));
        Assert.Equal(new Uri("https://agents.example.com:8443"), found[0].Gateway);
        Assert.Throws<FormatException>(() => EnrollmentCode.Parse("hat_plain_token"));
        Assert.Throws<FormatException>(() => EnrollmentCode.Parse(Code("http://agents.example.com", "hat_token_one_0123456789", fp)));
        Assert.Throws<FormatException>(() => EnrollmentCode.Parse(EnrollmentCode.Prefix + "not-base64!"));
    }

    [Fact]
    public async Task The_ca_is_accepted_only_when_it_matches_the_code()
    {
        var ca = SelfSignedCa();
        var good = EnrollmentCode.Parse(Code("https://agents.example.com", "hat_token_one_0123456789", EnrollmentCode.Fingerprint(ca)));
        var handler = new FakeGateway(ca);
        Assert.Equal(ca, await good.FetchCaAsync(handler, CancellationToken.None));
        Assert.Equal("/agent/v1/ca", handler.LastPath);
        var other = EnrollmentCode.Parse(Code("https://agents.example.com", "hat_token_one_0123456789", new string('b', 64)));
        await Assert.ThrowsAsync<CryptographicException>(() => other.FetchCaAsync(new FakeGateway(ca), CancellationToken.None));
    }

    [Fact]
    public async Task Install_enrolls_one_instance_per_code_and_registers_its_service()
    {
        var (setup, services, data, root, program) = Arrange();
        var fp = new string('a', 64);
        var codes = Path.Combine(_dir, "codes.ini");
        File.WriteAllText(codes, $"Code1={Code("https://agents.example.com", "hat_fias_0123456789abc", fp)}\nCode2={Code("https://agents.example.com", "hat_db_0123456789abcde", fp)}\nCode3={Code("https://agents.example.com", "hat_bad_0123456789abcd", fp)}\n");
        var output = new StringWriter();
        setup = new Setup(services, data, program, output);
        var exit = await setup.InstallAsync(codes, (code, _) => code.Token switch
        {
            "hat_fias_0123456789abc" => Task.FromResult(Result("i-fias", "OPERA5_FIAS", ["CHECKIN_EVENT"])),
            "hat_db_0123456789abcde" => Task.FromResult(Result("i-db", "OPERA5_DB", ["ARRIVALS_READ"])),
            _ => throw new GatewayHttpException(401, "integration.agent.enrollment_invalid"),
        }, CancellationToken.None);

        Assert.Equal(4, exit); // one code refused, the others installed
        Assert.False(File.Exists(codes)); // codes never stay on disk
        Assert.Contains("integration.agent.enrollment_invalid (HTTP 401)", output.ToString(), StringComparison.Ordinal);
        Assert.Equal(Path.GetDirectoryName(program), new DirectoryInfo(Path.Combine(root, "current")).LinkTarget);
        var fias = Path.Combine(data, "instances", "opera5-fias");
        Assert.True(new IdentityStore(fias).Exists);
        var settings = JsonNode.Parse(File.ReadAllText(Path.Combine(fias, "agent.json")))!["Agent"]!;
        Assert.Equal("OPERA5_FIAS", settings["ConnectorCode"]!.GetValue<string>());
        Assert.Equal("https://agents.example.com/", settings["Gateway"]!.GetValue<string>());
        Assert.Equal("CHECKIN_EVENT", settings["Capabilities"]![0]!.GetValue<string>());
        Assert.Equal(
            $"\"{Path.Combine(root, "current", "hotella-agent")}\" run --instance opera5-fias --data-root \"{data}\"",
            services.Created["HotellaAgent-opera5-fias"]);
        Assert.True(services.Created.ContainsKey("HotellaAgent-opera5-db"));

        // Run again with a code for an instance that exists: kept, never replaced silently.
        File.WriteAllText(codes, Code("https://agents.example.com", "hat_fias_0123456789abc", fp));
        var again = new StringWriter();
        Assert.Equal(0, await new Setup(services, data, program, again).InstallAsync(codes,
            (_, _) => Task.FromResult(Result("i-fias-2", "OPERA5_FIAS", [])), CancellationToken.None));
        Assert.Contains("already enrolled; kept", again.ToString(), StringComparison.Ordinal);
        Assert.Equal("i-fias", new IdentityStore(fias).Load()!.InstanceId);
    }

    [Fact]
    public async Task Without_codes_the_single_instance_layout_of_install_ps1_is_kept()
    {
        var (setup, services, data, _, program) = Arrange();
        File.WriteAllText(Path.Combine(Path.GetDirectoryName(program)!, "agent.example.json"), "{\"Agent\":{}}");
        Assert.Equal(0, await setup.InstallAsync(null, (_, _) => throw new InvalidOperationException(), CancellationToken.None));
        Assert.True(File.Exists(Path.Combine(data, "agent.json")));
        Assert.Contains("\" run --data-root", services.Created["HotellaAgent"], StringComparison.Ordinal);
    }

    [Fact]
    public async Task An_upgrade_without_codes_keeps_the_connector_services_and_adds_no_single_instance_service()
    {
        var (setup, services, _, _, _) = Arrange();
        var codes = Path.Combine(_dir, "codes.txt");
        File.WriteAllText(codes, Code("https://agents.example.com", "hat_fias_0123456789abc", new string('a', 64)));
        await setup.InstallAsync(codes, (_, _) => Task.FromResult(Result("i-fias", "OPERA5_FIAS", [])), CancellationToken.None);
        Assert.Equal(0, await setup.InstallAsync(null, (_, _) => throw new InvalidOperationException(), CancellationToken.None));
        Assert.Equal(["HotellaAgent-opera5-fias"], services.Created.Keys);
    }

    [Fact]
    public async Task Remove_deletes_services_and_updater_versions_and_keeps_identities_unless_asked()
    {
        var (setup, services, data, root, program) = Arrange();
        var fp = new string('a', 64);
        var codes = Path.Combine(_dir, "codes.txt");
        File.WriteAllText(codes, Code("https://agents.example.com", "hat_fias_0123456789abc", fp));
        await setup.InstallAsync(codes, (_, _) => Task.FromResult(Result("i-fias", "OPERA5_FIAS", [])), CancellationToken.None);
        var updaterVersion = Path.Combine(root, "versions", "0.10.9");
        Directory.CreateDirectory(updaterVersion);

        Assert.Equal(0, setup.Remove(removeData: false));
        Assert.Contains("HotellaAgent-opera5-fias", services.Deleted);
        Assert.False(Directory.Exists(updaterVersion));
        Assert.True(Directory.Exists(Path.GetDirectoryName(program)));
        Assert.False(Directory.Exists(Path.Combine(root, "current")));
        Assert.True(new IdentityStore(Path.Combine(data, "instances", "opera5-fias")).Exists);
        setup.Remove(removeData: true);
        Assert.False(Directory.Exists(data));
    }

    [Fact]
    public async Task Only_configured_instances_start_and_stop_reaches_every_service()
    {
        var (_, services, data, _, program) = Arrange();
        var fp = new string('a', 64);
        var codes = Path.Combine(_dir, "codes.txt");
        File.WriteAllText(codes, Code("https://agents.example.com", "hat_fias_0123456789abc", fp) + "\n"
            + Code("https://agents.example.com", "hat_db_0123456789abcde", fp));
        var setup = new Setup(services, data, program, TextWriter.Null, instance => instance == "opera5-db");
        await setup.InstallAsync(codes, (code, _) => Task.FromResult(code.Token.StartsWith("hat_db", StringComparison.Ordinal)
            ? Result("i-db", "OPERA5_DB", []) : Result("i-fias", "OPERA5_FIAS", [])), CancellationToken.None);
        Assert.Equal(["HotellaAgent-opera5-db"], services.Started);
        setup.Stop();
        Assert.Equal(["HotellaAgent-opera5-db", "HotellaAgent-opera5-fias"], services.Stopped.Order(StringComparer.Ordinal));
    }

    [Fact]
    public void Instance_names_are_checked_and_map_to_their_own_directory_and_service()
    {
        Assert.Equal("opera5-fias", AgentHost.Instance(["run", "--instance", "opera5-fias"]));
        Assert.Null(AgentHost.Instance(["run"]));
        Assert.Throws<ArgumentException>(() => AgentHost.Instance(["run", "--instance", "../etc"]));
        Assert.Equal("HotellaAgent-opera5-db", AgentHost.ServiceNameOf("opera5-db"));
        Assert.Equal("opera5-ows", Setup.InstanceName("OPERA5_OWS"));
        Assert.EndsWith(Path.Combine("instances", "opera5-fias"), AgentHost.InstanceDirectory("opera5-fias"), StringComparison.Ordinal);
    }

    private (Setup setup, FakeServices services, string data, string root, string program) Arrange()
    {
        var root = Path.Combine(_dir, "Agent");
        var version = Path.Combine(root, "versions", "0.11.0");
        Directory.CreateDirectory(version);
        var program = Path.Combine(version, "hotella-agent");
        File.WriteAllText(program, "");
        var data = Path.Combine(_dir, "data");
        var services = new FakeServices();
        return (new Setup(services, data, program, TextWriter.Null), services, data, root, program);
    }

    private static EnrollmentResult Result(string id, string connector, string[] capabilities) =>
        new(new AgentIdentity(id, "key", "cert", "ca", "cmd"), connector, capabilities);

    public void Dispose() => Directory.Delete(_dir, recursive: true);

    private sealed class FakeServices : IServiceManager
    {
        public Dictionary<string, string> Created { get; } = [];
        public List<string> Deleted { get; } = [];
        public bool Exists(string name) => Created.ContainsKey(name);
        public void Create(string name, string displayName, string commandLine) => Created[name] = commandLine;
        public List<string> Started { get; } = [];
        public List<string> Stopped { get; } = [];
        public void Start(string name) => Started.Add(name);
        public void Stop(string name) => Stopped.Add(name);
        public void StopAndDelete(string name)
        {
            Created.Remove(name);
            Deleted.Add(name);
        }
    }

    private sealed class FakeGateway(string ca) : HttpMessageHandler
    {
        public string? LastPath { get; private set; }

        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            LastPath = request.RequestUri!.AbsolutePath;
            return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK)
            {
                Content = new StringContent(JsonSerializer.Serialize(new { ca_certificate = ca }), Encoding.UTF8, "application/json"),
            });
        }
    }
}
