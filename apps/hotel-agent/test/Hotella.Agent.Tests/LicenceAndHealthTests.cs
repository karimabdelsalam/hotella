using System.Text;
using System.Text.Json.Nodes;
using Hotella.Agent.Core.Hosting;
using Hotella.Agent.Core.Json;
using Hotella.Agent.Core.Licensing;
using Hotella.Agent.Core.Security;
using Org.BouncyCastle.Crypto.Generators;
using Org.BouncyCastle.Crypto.Parameters;
using Org.BouncyCastle.Crypto.Signers;
using Org.BouncyCastle.Security;
using Org.BouncyCastle.X509;

namespace Hotella.Agent.Tests;

public sealed class LicenceAndHealthTests : IDisposable
{
    private const string Instance = "01900000-0000-7000-8000-0000000001aa";
    private static readonly DateTimeOffset Issued = new(2026, 10, 1, 0, 0, 0, TimeSpan.Zero);
    private readonly string _dir = Directory.CreateTempSubdirectory("hotella-licence-").FullName;
    private readonly Ed25519PrivateKeyParameters _platform;
    private readonly CommandSignature _pinned;

    public LicenceAndHealthTests()
    {
        var generator = new Ed25519KeyPairGenerator();
        generator.Init(new Ed25519KeyGenerationParameters(new SecureRandom()));
        var pair = generator.GenerateKeyPair();
        _platform = (Ed25519PrivateKeyParameters)pair.Private;
        var spki = SubjectPublicKeyInfoFactory.CreateSubjectPublicKeyInfo(pair.Public).GetDerEncoded();
        _pinned = new CommandSignature($"-----BEGIN PUBLIC KEY-----\n{Convert.ToBase64String(spki)}\n-----END PUBLIC KEY-----\n");
    }

    private JsonObject Sign(JsonObject body, Ed25519PrivateKeyParameters? key = null)
    {
        var bytes = Encoding.UTF8.GetBytes(CanonicalJson.Serialize(body));
        var signer = new Ed25519Signer();
        signer.Init(true, key ?? _platform);
        signer.BlockUpdate(bytes, 0, bytes.Length);
        var signed = (JsonObject)body.DeepClone();
        signed["signature"] = Convert.ToBase64String(signer.GenerateSignature()).TrimEnd('=').Replace('+', '-').Replace('/', '_');
        return signed;
    }

    private static JsonObject Body(DateTimeOffset issued, string instance = Instance, string typ = Licence.Type) => new()
    {
        ["typ"] = typ,
        ["instance_id"] = instance,
        ["tenant_id"] = "01900000-0000-7000-8000-0000000000aa",
        ["property_id"] = "01900000-0000-7000-8000-0000000000bb",
        ["connector_code"] = "OPERA5_FIAS",
        ["capabilities"] = new JsonArray("CHECKIN_EVENT", "RECONCILIATION_READ"),
        ["issued_at"] = issued.ToString("yyyy-MM-ddTHH:mm:ss.fffZ"),
        ["expires_at"] = issued.AddDays(30).ToString("yyyy-MM-ddTHH:mm:ss.fffZ"),
        ["grace_days"] = 14,
    };

    [Fact]
    public void A_licence_is_valid_then_in_grace_then_expired_and_only_then_refuses_commands()
    {
        var store = new LicenceStore(_dir, _pinned, Instance);
        Assert.Equal(LicenceState.Missing, store.StateAt(Issued));
        Assert.NotNull(store.CommandRefusal(Issued));
        Assert.True(store.Offer(Sign(Body(Issued))));
        Assert.Equal(LicenceState.Valid, store.StateAt(Issued.AddDays(29)));
        Assert.Null(store.CommandRefusal(Issued.AddDays(29)));
        Assert.Equal(LicenceState.Grace, store.StateAt(Issued.AddDays(31)));
        Assert.Null(store.CommandRefusal(Issued.AddDays(43)));
        Assert.Equal(LicenceState.Expired, store.StateAt(Issued.AddDays(44)));
        Assert.Contains("expired", store.CommandRefusal(Issued.AddDays(44)), StringComparison.Ordinal);
        // Kept on disk and re-verified by a new process.
        Assert.Equal(LicenceState.Valid, new LicenceStore(_dir, _pinned, Instance).StateAt(Issued.AddDays(1)));
    }

    [Fact]
    public void Forged_foreign_mistyped_or_older_licences_are_refused()
    {
        var store = new LicenceStore(_dir, _pinned, Instance);
        var generator = new Ed25519KeyPairGenerator();
        generator.Init(new Ed25519KeyGenerationParameters(new SecureRandom()));
        var stranger = (Ed25519PrivateKeyParameters)generator.GenerateKeyPair().Private;
        Assert.False(store.Offer(Sign(Body(Issued), stranger)));
        Assert.False(store.Offer(Sign(Body(Issued, instance: "01900000-0000-7000-8000-0000000009ff"))));
        Assert.False(store.Offer(Sign(Body(Issued, typ: "command"))));
        var tampered = Sign(Body(Issued));
        tampered["grace_days"] = 90;
        Assert.False(store.Offer(tampered));
        Assert.True(store.Offer(Sign(Body(Issued.AddDays(5)))));
        Assert.False(store.Offer(Sign(Body(Issued)))); // an older one never replaces a newer one
        Assert.Equal(Issued.AddDays(5), store.Current!.IssuedAt);
        // A hand-edited file is worthless.
        File.WriteAllText(Path.Combine(_dir, "licence.json"), tampered.ToJsonString());
        Assert.Equal(LicenceState.Missing, new LicenceStore(_dir, _pinned, Instance).StateAt(Issued));
    }

    private static HealthInputs Inputs(
        bool connected = true, double downMinutes = 0, bool? adapterUp = true, LicenceState licence = LicenceState.Valid,
        long queue = 0, double certificateDays = 60)
    {
        var now = Issued;
        return new HealthInputs(now, connected, connected ? null : now.AddMinutes(-downMinutes), adapterUp,
            adapterUp == false ? "IFC8 link down" : null, licence, queue, now.AddDays(certificateDays));
    }

    [Fact]
    public void Health_is_classified_by_rules_with_the_reasons()
    {
        Assert.Equal((HealthStatus.Healthy, 0), Summary(Inputs()));
        Assert.Equal((HealthStatus.Healthy, 0), Summary(Inputs(adapterUp: null))); // a connector without an adapter
        Assert.Equal((HealthStatus.Degraded, 1), Summary(Inputs(connected: false, downMinutes: 3)));
        Assert.Equal((HealthStatus.Unhealthy, 1), Summary(Inputs(connected: false, downMinutes: 16)));
        Assert.Equal((HealthStatus.Degraded, 1), Summary(Inputs(adapterUp: false)));
        Assert.Equal((HealthStatus.Degraded, 1), Summary(Inputs(licence: LicenceState.Grace)));
        Assert.Equal((HealthStatus.Unhealthy, 1), Summary(Inputs(licence: LicenceState.Expired)));
        Assert.Equal((HealthStatus.Degraded, 1), Summary(Inputs(queue: 1000)));
        Assert.Equal((HealthStatus.Degraded, 1), Summary(Inputs(certificateDays: 5)));
        Assert.Equal((HealthStatus.Unhealthy, 1), Summary(Inputs(certificateDays: -1)));
        var (status, reasons) = AgentHealth.Classify(Inputs(licence: LicenceState.Expired, adapterUp: false));
        Assert.Equal(HealthStatus.Unhealthy, status);
        Assert.Equal(["licence expired past its grace: commands are refused", "PMS side: IFC8 link down"], reasons);
        Assert.Equal("UNHEALTHY", AgentHealth.Report(Inputs(licence: LicenceState.Expired), "1.0")["status"]!.GetValue<string>());
    }

    private static (HealthStatus, int) Summary(HealthInputs h)
    {
        var (status, reasons) = AgentHealth.Classify(h);
        return (status, reasons.Count);
    }

    public void Dispose() => Directory.Delete(_dir, recursive: true);
}
