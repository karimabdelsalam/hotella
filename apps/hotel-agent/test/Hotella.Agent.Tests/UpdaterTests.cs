using System.IO.Compression;
using System.Net;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json.Nodes;
using Hotella.Agent.Core.Json;
using Hotella.Agent.Core.Security;
using Hotella.Agent.Updater;
using Org.BouncyCastle.Crypto.Generators;
using Org.BouncyCastle.Crypto.Parameters;
using Org.BouncyCastle.Crypto.Signers;
using Org.BouncyCastle.Security;
using Org.BouncyCastle.X509;

namespace Hotella.Agent.Tests;

public sealed class UpdaterTests : IDisposable
{
    private static readonly DateTimeOffset T0 = new(2026, 10, 4, 9, 0, 0, TimeSpan.Zero);
    private static readonly Version Running = new(0, 10, 1);
    private static readonly Version Next = new(0, 10, 2);
    private readonly string _root = Directory.CreateTempSubdirectory("hotella-install-").FullName;
    private readonly InstallLayout _layout;
    private readonly Ed25519PrivateKeyParameters _releaseKey;
    private readonly CommandSignature _pinned;
    private readonly Releases _server = new();

    public UpdaterTests()
    {
        var generator = new Ed25519KeyPairGenerator();
        generator.Init(new Ed25519KeyGenerationParameters(new SecureRandom()));
        var pair = generator.GenerateKeyPair();
        _releaseKey = (Ed25519PrivateKeyParameters)pair.Private;
        var spki = SubjectPublicKeyInfoFactory.CreateSubjectPublicKeyInfo(pair.Public).GetDerEncoded();
        _pinned = new CommandSignature($"-----BEGIN PUBLIC KEY-----\n{Convert.ToBase64String(spki)}\n-----END PUBLIC KEY-----\n");
        _layout = new InstallLayout(_root);
        // The installed version, as the installer leaves it.
        Directory.CreateDirectory(_layout.VersionDirectory(Running));
        File.WriteAllText(Path.Combine(_layout.VersionDirectory(Running), "hotella-agent"), "0.10.1");
        Directory.CreateSymbolicLink(_layout.Current, _layout.VersionDirectory(Running));
    }

    private static byte[] Package(string marker)
    {
        using var buffer = new MemoryStream();
        using (var zip = new ZipArchive(buffer, ZipArchiveMode.Create, leaveOpen: true))
        {
            var entry = zip.CreateEntry("hotella-agent");
            using var w = new StreamWriter(entry.Open());
            w.Write(marker);
        }
        return buffer.ToArray();
    }

    private JsonObject Manifest(Version version, byte[] package, Action<JsonObject>? tamper = null, Ed25519PrivateKeyParameters? key = null)
    {
        var body = new JsonObject
        {
            ["typ"] = UpdateManifest.Type,
            ["version"] = version.ToString(),
            ["package_url"] = $"https://updates.example/agent/{version}.zip",
            ["sha256"] = Convert.ToHexStringLower(SHA256.HashData(package)),
            ["size"] = package.Length,
            ["channel"] = "stable",
        };
        var bytes = Encoding.UTF8.GetBytes(CanonicalJson.Serialize(body));
        var signer = new Ed25519Signer();
        signer.Init(true, key ?? _releaseKey);
        signer.BlockUpdate(bytes, 0, bytes.Length);
        body["signature"] = Convert.ToBase64String(signer.GenerateSignature()).TrimEnd('=').Replace('+', '-').Replace('/', '_');
        tamper?.Invoke(body);
        return body;
    }

    private static readonly Uri ManifestUrl = new("https://updates.example/agent/stable.json");

    private AgentUpdater Updater() => new(_layout, _pinned, _server);
    private string CurrentMarker() => File.ReadAllText(Path.Combine(_layout.Current, "hotella-agent"));

    [Fact]
    public async Task A_signed_newer_release_is_staged_switched_and_confirmed()
    {
        var package = Package("0.10.2");
        _server.Serve(ManifestUrl, Manifest(Next, package).ToJsonString());
        _server.Serve(new Uri("https://updates.example/agent/0.10.2.zip"), package);
        var updater = Updater();

        var manifest = await updater.CheckAsync(ManifestUrl, Running, CancellationToken.None);
        Assert.Equal(Next, manifest!.Version);
        Assert.Null(await updater.CheckAsync(ManifestUrl, Next, CancellationToken.None)); // already running it
        await updater.StageAsync(manifest, CancellationToken.None);
        Assert.Equal("0.10.1", CurrentMarker()); // staging never touches the running version
        updater.Switch(Next, Running, T0);
        Assert.Equal("0.10.2", CurrentMarker());
        Assert.Equal(UpdateStatus.Probation, updater.State.Status);

        Assert.True(updater.OnStartup(Next, T0.AddMinutes(1)));
        Assert.False(updater.ProbationFailed(Next, T0.AddMinutes(2)));
        updater.Confirm(Next);
        Assert.Equal(UpdateStatus.Confirmed, updater.State.Status);
        Assert.True(updater.OnStartup(Next, T0.AddHours(5)));
    }

    [Fact]
    public async Task Forged_tampered_or_corrupt_releases_are_refused_before_anything_changes()
    {
        var package = Package("0.10.2");
        var generator = new Ed25519KeyPairGenerator();
        generator.Init(new Ed25519KeyGenerationParameters(new SecureRandom()));
        var stranger = (Ed25519PrivateKeyParameters)generator.GenerateKeyPair().Private;
        var updater = Updater();

        _server.Serve(ManifestUrl, Manifest(Next, package, key: stranger).ToJsonString());
        await Assert.ThrowsAsync<InvalidDataException>(() => updater.CheckAsync(ManifestUrl, Running, CancellationToken.None));
        _server.Serve(ManifestUrl, Manifest(Next, package, m => m["package_url"] = "https://evil.example/x.zip").ToJsonString());
        await Assert.ThrowsAsync<InvalidDataException>(() => updater.CheckAsync(ManifestUrl, Running, CancellationToken.None));

        var good = UpdateManifest.Verify(Manifest(Next, package), _pinned)!;
        _server.Serve(good.Package, Package("something else"));
        await Assert.ThrowsAsync<InvalidDataException>(() => updater.StageAsync(good, CancellationToken.None));
        Assert.False(Directory.Exists(_layout.VersionDirectory(Next)));
        Assert.Equal("0.10.1", CurrentMarker());
    }

    [Fact]
    public async Task A_candidate_that_keeps_failing_to_start_is_rolled_back_and_blocked()
    {
        var package = Package("0.10.2");
        _server.Serve(ManifestUrl, Manifest(Next, package).ToJsonString());
        _server.Serve(new Uri("https://updates.example/agent/0.10.2.zip"), package);
        var updater = Updater();
        await updater.StageAsync((await updater.CheckAsync(ManifestUrl, Running, CancellationToken.None))!, CancellationToken.None);
        updater.Switch(Next, Running, T0);

        for (var i = 0; i < AgentUpdater.MaxStarts; i++) Assert.True(updater.OnStartup(Next, T0.AddMinutes(i)));
        Assert.False(updater.OnStartup(Next, T0.AddMinutes(4))); // the fourth start goes back
        Assert.Equal("0.10.1", CurrentMarker());
        Assert.Equal(UpdateStatus.RolledBack, updater.State.Status);
        Assert.Equal(["0.10.2"], updater.State.Blocked);
        // The previous version starts normally, and the blocked release is not offered again.
        Assert.True(updater.OnStartup(Running, T0.AddMinutes(5)));
        Assert.Null(await updater.CheckAsync(ManifestUrl, Running, CancellationToken.None));
    }

    [Fact]
    public async Task A_candidate_that_never_becomes_healthy_is_rolled_back_after_its_probation()
    {
        var package = Package("0.10.2");
        _server.Serve(new Uri("https://updates.example/agent/0.10.2.zip"), package);
        var updater = Updater();
        await updater.StageAsync(UpdateManifest.Verify(Manifest(Next, package), _pinned)!, CancellationToken.None);
        updater.Switch(Next, Running, T0);
        Assert.True(updater.OnStartup(Next, T0));
        Assert.True(updater.ProbationFailed(Next, T0 + AgentUpdater.Probation + TimeSpan.FromSeconds(1)));
        updater.Rollback("the new version stayed unhealthy");
        Assert.Equal("0.10.1", CurrentMarker());
        Assert.Contains("rolled back to 0.10.1", AgentUpdater.Describe(updater.State), StringComparison.Ordinal);
    }

    public void Dispose() => Directory.Delete(_root, recursive: true);

    private sealed class Releases : HttpMessageHandler
    {
        private readonly Dictionary<Uri, byte[]> _files = [];

        public void Serve(Uri url, string body) => _files[url] = Encoding.UTF8.GetBytes(body);
        public void Serve(Uri url, byte[] body) => _files[url] = body;

        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken) =>
            Task.FromResult(_files.TryGetValue(request.RequestUri!, out var body)
                ? new HttpResponseMessage(HttpStatusCode.OK) { Content = new ByteArrayContent(body) }
                : new HttpResponseMessage(HttpStatusCode.NotFound));
    }
}
