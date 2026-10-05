using System.Net.Http.Json;
using System.Text.Json.Serialization;

namespace Hotella.Agent.Core.Security;

/// <summary>One-time enrollment (ADR-0017 §2): a local key and CSR exchanged with the single-use token.</summary>
public static class Enrollment
{
    public const string EnrollPath = "/agent/v1/enroll";
    public const string RenewPath = "/agent/v1/renew";

    private sealed record EnrollRequest(
        [property: JsonPropertyName("token")] string Token,
        [property: JsonPropertyName("csr")] string Csr,
        [property: JsonPropertyName("agent_version")] string AgentVersion);

    private sealed record EnrollResponse(
        [property: JsonPropertyName("instance_id")] string InstanceId,
        [property: JsonPropertyName("certificate")] string Certificate,
        [property: JsonPropertyName("ca_certificate")] string CaCertificate,
        [property: JsonPropertyName("not_after")] string NotAfter,
        [property: JsonPropertyName("command_signing_public_key")] string CommandSigningPublicKey,
        [property: JsonPropertyName("connector_code")] string? ConnectorCode = null,
        [property: JsonPropertyName("capabilities")] IReadOnlyList<string>? Capabilities = null);

    private sealed record RenewRequest([property: JsonPropertyName("csr")] string Csr);

    private sealed record RenewResponse(
        [property: JsonPropertyName("certificate")] string Certificate,
        [property: JsonPropertyName("not_after")] string NotAfter);

    public static async Task<AgentIdentity> EnrollAsync(
        Uri gateway, string token, string caCertificatePem, string agentVersion, CancellationToken ct) =>
        (await EnrollWithProfileAsync(gateway, token, caCertificatePem, agentVersion, ct).ConfigureAwait(false)).Identity;

    /// <summary>
    /// Enrollment that also returns what the instance is — its connector and enabled capabilities — when the platform
    /// sends them (ADR-0020), so an installer needs nothing but the enrollment code.
    /// </summary>
    public static async Task<EnrollmentResult> EnrollWithProfileAsync(
        Uri gateway, string token, string caCertificatePem, string agentVersion, CancellationToken ct)
    {
        var (privateKeyPem, csrPem) = AgentTls.CreateKeyAndCsr();
        using var http = new HttpClient(AgentTls.CreateHandler(caCertificatePem, null)) { BaseAddress = gateway };
        using var res = await http.PostAsJsonAsync(EnrollPath, new EnrollRequest(token, csrPem, agentVersion), ct)
            .ConfigureAwait(false);
        await LinkHttp.EnsureSuccessAsync(res, ct).ConfigureAwait(false);
        var body = await res.Content.ReadFromJsonAsync<EnrollResponse>(ct).ConfigureAwait(false)
            ?? throw new InvalidDataException("empty enrollment response");
        return new EnrollmentResult(
            new AgentIdentity(body.InstanceId, privateKeyPem, body.Certificate, body.CaCertificate,
                body.CommandSigningPublicKey),
            body.ConnectorCode,
            body.Capabilities ?? []);
    }

    /// <summary>Renews the device certificate with a fresh key, authenticated by the current one.</summary>
    public static async Task<AgentIdentity> RenewAsync(Uri gateway, AgentIdentity identity, CancellationToken ct)
    {
        var (privateKeyPem, csrPem) = AgentTls.CreateKeyAndCsr();
        using var http = new HttpClient(AgentTls.CreateHandler(identity.CaCertificatePem, identity))
        {
            BaseAddress = gateway,
        };
        using var res = await http.PostAsJsonAsync(RenewPath, new RenewRequest(csrPem), ct).ConfigureAwait(false);
        await LinkHttp.EnsureSuccessAsync(res, ct).ConfigureAwait(false);
        var body = await res.Content.ReadFromJsonAsync<RenewResponse>(ct).ConfigureAwait(false)
            ?? throw new InvalidDataException("empty renewal response");
        return identity with { PrivateKeyPem = privateKeyPem, CertificatePem = body.Certificate };
    }
}

/// <summary>An enrolled identity and, from newer platforms, the instance's connector and enabled capabilities.</summary>
public sealed record EnrollmentResult(AgentIdentity Identity, string? ConnectorCode, IReadOnlyList<string> Capabilities);

/// <summary>An HTTP refusal from the gateway, with the platform's problem code when it sent one.</summary>
public sealed class GatewayHttpException(int status, string code)
    : Exception($"gateway answered HTTP {status} ({code})")
{
    public int Status { get; } = status;
    public string Code { get; } = code;
}

internal static class LinkHttp
{
    public static async Task EnsureSuccessAsync(HttpResponseMessage res, CancellationToken ct)
    {
        if (res.IsSuccessStatusCode) return;
        var code = "error";
        try
        {
            var problem = await res.Content.ReadFromJsonAsync<Dictionary<string, object?>>(ct).ConfigureAwait(false);
            if (problem?.TryGetValue("code", out var c) == true && c is not null) code = c.ToString() ?? code;
        }
        catch (System.Text.Json.JsonException)
        {
            // Not a JSON problem document.
        }
        throw new GatewayHttpException((int)res.StatusCode, code);
    }
}
