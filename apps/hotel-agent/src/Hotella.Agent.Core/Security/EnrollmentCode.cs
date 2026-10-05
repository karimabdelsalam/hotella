using System.Net.Http.Json;
using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace Hotella.Agent.Core.Security;

/// <summary>
/// The one value an installer pastes (ADR-0020): <c>hotella1.</c> + base64url of <c>{ g: gateway, t: token, c: CA
/// SHA-256 }</c>. The CA is fetched from the gateway over an unverified channel and accepted only if its fingerprint
/// matches the code — the code, delivered out of band, is the trust anchor.
/// </summary>
public sealed record EnrollmentCode(Uri Gateway, string Token, string CaSha256)
{
    public const string Prefix = "hotella1.";
    public const string CaPath = "/agent/v1/ca";

    private sealed record Body(
        [property: JsonPropertyName("g")] string? G,
        [property: JsonPropertyName("t")] string? T,
        [property: JsonPropertyName("c")] string? C);

    private sealed record CaResponse([property: JsonPropertyName("ca_certificate")] string CaCertificate);

    /// <summary>Every enrollment code in a text (a list, an .ini file written by the MSI, …).</summary>
    public static IReadOnlyList<EnrollmentCode> FindAll(string text)
    {
        ArgumentNullException.ThrowIfNull(text);
        return [.. text.Split(['\r', '\n', '=', ' ', '\t', '"'], StringSplitOptions.RemoveEmptyEntries)
            .Where(w => w.StartsWith(Prefix, StringComparison.Ordinal))
            .Select(Parse)];
    }

    public static EnrollmentCode Parse(string value)
    {
        ArgumentNullException.ThrowIfNull(value);
        var text = value.Trim();
        if (!text.StartsWith(Prefix, StringComparison.Ordinal)) throw new FormatException("not a Hotella enrollment code");
        Body? body;
        try
        {
            var b64 = text[Prefix.Length..].Replace('-', '+').Replace('_', '/');
            b64 = b64.PadRight(b64.Length + ((4 - (b64.Length % 4)) % 4), '=');
            body = JsonSerializer.Deserialize<Body>(Encoding.UTF8.GetString(Convert.FromBase64String(b64)));
        }
        catch (Exception e) when (e is FormatException or JsonException)
        {
            throw new FormatException("the enrollment code is damaged; copy it again from the platform");
        }
        if (body?.G is null || body.T is null || body.C is null
            || !Uri.TryCreate(body.G, UriKind.Absolute, out var gateway) || gateway.Scheme != Uri.UriSchemeHttps
            || body.C.Length != 64 || !body.C.All(char.IsAsciiHexDigitLower))
            throw new FormatException("the enrollment code is damaged; copy it again from the platform");
        return new EnrollmentCode(gateway, body.T, body.C);
    }

    /// <summary>SHA-256 of a certificate's DER bytes, lowercase hex.</summary>
    public static string Fingerprint(string pem)
    {
        using var cert = X509Certificate2.CreateFromPem(pem);
        return Convert.ToHexStringLower(SHA256.HashData(cert.RawData));
    }

    /// <summary>The platform's agent CA, accepted only when it matches the code's fingerprint.</summary>
    public async Task<string> FetchCaAsync(HttpMessageHandler? handler, CancellationToken ct)
    {
        using var http = new HttpClient(handler ?? UnverifiedHandler(), disposeHandler: true) { BaseAddress = Gateway };
        var body = await http.GetFromJsonAsync<CaResponse>(CaPath, ct).ConfigureAwait(false)
            ?? throw new InvalidDataException("the gateway sent no CA certificate");
        if (!string.Equals(Fingerprint(body.CaCertificate), CaSha256, StringComparison.Ordinal))
            throw new CryptographicException(
                "the gateway's CA does not match the enrollment code: wrong address, or someone is in between");
        return body.CaCertificate;
    }

    private static SocketsHttpHandler UnverifiedHandler() => new()
    {
        SslOptions =
        {
            // Not trusted yet by design: the CA we receive is checked against the fingerprint in the code before use,
            // and nothing secret is sent on this request.
#pragma warning disable CA5359
            RemoteCertificateValidationCallback = (_, _, _, _) => true,
#pragma warning restore CA5359
        },
    };
}
