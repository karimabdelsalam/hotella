using System.Net.Security;
using System.Security.Authentication;
using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;

namespace Hotella.Agent.Core.Security;

/// <summary>
/// TLS for the link (ADR-0017 §2): TLS 1.3 only, the gateway's certificate must chain to the pinned Planova agent CA
/// (no system trust store) and match the host name; after enrollment the device certificate is presented as the
/// client certificate (mutual TLS).
/// </summary>
public static class AgentTls
{
    public static SocketsHttpHandler CreateHandler(string caCertificatePem, AgentIdentity? identity)
    {
        var ca = X509Certificate2.CreateFromPem(caCertificatePem);
        var handler = new SocketsHttpHandler
        {
            PooledConnectionLifetime = TimeSpan.FromMinutes(10),
            ConnectTimeout = TimeSpan.FromSeconds(15),
            UseProxy = true,
        };
        handler.SslOptions = new SslClientAuthenticationOptions
        {
            EnabledSslProtocols = SslProtocols.Tls13,
            RemoteCertificateValidationCallback = (_, certificate, _, errors) =>
                certificate is not null && ValidateServer(new X509Certificate2(certificate), errors, ca),
        };
        if (identity is not null)
            handler.SslOptions.ClientCertificates = [ClientCertificate(identity)];
        return handler;
    }

    /// <summary>The device certificate with its private key, usable by the OS TLS stack.</summary>
    public static X509Certificate2 ClientCertificate(AgentIdentity identity)
    {
        using var ephemeral = X509Certificate2.CreateFromPem(identity.CertificatePem, identity.PrivateKeyPem);
        // Windows (Schannel) cannot use an ephemeral key for client authentication: round-trip through PKCS#12.
        return X509CertificateLoader.LoadPkcs12(ephemeral.Export(X509ContentType.Pkcs12), null);
    }

    internal static bool ValidateServer(X509Certificate2 server, SslPolicyErrors errors, X509Certificate2 ca)
    {
        // The host name must match; chain errors are re-evaluated against the pinned CA only.
        if ((errors & SslPolicyErrors.RemoteCertificateNameMismatch) != 0) return false;
        if ((errors & SslPolicyErrors.RemoteCertificateNotAvailable) != 0) return false;
        using var chain = new X509Chain();
        chain.ChainPolicy.TrustMode = X509ChainTrustMode.CustomRootTrust;
        chain.ChainPolicy.CustomTrustStore.Add(ca);
        chain.ChainPolicy.RevocationMode = X509RevocationMode.NoCheck;
        return chain.Build(server);
    }

    /// <summary>A new ECDSA P-256 key and a PEM certificate request for it (the platform sets the subject).</summary>
    public static (string privateKeyPem, string csrPem) CreateKeyAndCsr()
    {
        using var key = ECDsa.Create(ECCurve.NamedCurves.nistP256);
        var request = new CertificateRequest("CN=hotella-agent", key, HashAlgorithmName.SHA256);
        return (key.ExportPkcs8PrivateKeyPem(), request.CreateSigningRequestPem());
    }
}
