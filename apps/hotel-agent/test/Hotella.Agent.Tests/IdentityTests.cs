using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using Hotella.Agent.Core.Security;

namespace Hotella.Agent.Tests;

public sealed class IdentityTests : IDisposable
{
    private readonly string _dir = Directory.CreateTempSubdirectory("hotella-identity-").FullName;

    [Fact]
    public void Creates_a_P256_key_and_a_certificate_request_signed_by_it()
    {
        var (keyPem, csrPem) = AgentTls.CreateKeyAndCsr();
        using var key = ECDsa.Create();
        key.ImportFromPem(keyPem);
        Assert.Equal(256, key.KeySize);
        var request = CertificateRequest.LoadSigningRequestPem(csrPem, HashAlgorithmName.SHA256);
        Assert.Equal("CN=hotella-agent", request.SubjectName.Name);
    }

    [Fact]
    public void Stores_the_identity_with_owner_only_permissions()
    {
        var store = new IdentityStore(Path.Combine(_dir, "data"));
        var identity = new AgentIdentity("01900000-0000-7000-8000-0000000001aa", "KEY", "CERT", "CA", "PUB");
        store.Save(identity);
        Assert.Equal(identity, store.Load());
        if (!OperatingSystem.IsWindows())
            Assert.Equal(UnixFileMode.UserRead | UnixFileMode.UserWrite,
                File.GetUnixFileMode(Path.Combine(_dir, "data", "identity.json")));
    }

    public void Dispose() => Directory.Delete(_dir, recursive: true);
}
