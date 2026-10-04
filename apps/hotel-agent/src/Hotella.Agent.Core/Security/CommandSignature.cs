using System.Text;
using System.Text.Json.Nodes;
using Hotella.Agent.Core.Json;
using Org.BouncyCastle.Crypto.Parameters;
using Org.BouncyCastle.Crypto.Signers;
using Org.BouncyCastle.Security;

namespace Hotella.Agent.Core.Security;

/// <summary>
/// Verifies the platform's Ed25519 signature on a command frame (ADR-0017 §5) against the key pinned at enrollment: the
/// signature covers the canonical JSON of the frame without its <c>signature</c> field. A command that does not verify
/// is never executed.
/// </summary>
public sealed class CommandSignature
{
    private readonly Ed25519PublicKeyParameters _key;

    public CommandSignature(string publicKeyPem)
    {
        var der = PemToDer(publicKeyPem);
        _key = (Ed25519PublicKeyParameters)PublicKeyFactory.CreateKey(der);
    }

    public bool Verify(JsonObject frame)
    {
        if (frame["signature"] is not JsonValue sig || !sig.TryGetValue<string>(out var signature)) return false;
        var body = (JsonObject)frame.DeepClone();
        body.Remove("signature");
        byte[] signatureBytes;
        try
        {
            signatureBytes = Base64Url.Decode(signature);
        }
        catch (FormatException)
        {
            return false;
        }
        if (signatureBytes.Length != 64) return false;
        var message = Encoding.UTF8.GetBytes(CanonicalJson.Serialize(body));
        var signer = new Ed25519Signer();
        signer.Init(false, _key);
        signer.BlockUpdate(message, 0, message.Length);
        return signer.VerifySignature(signatureBytes);
    }

    private static byte[] PemToDer(string pem)
    {
        var base64 = string.Concat(
            pem.Split('\n').Select(l => l.Trim()).Where(l => l.Length > 0 && !l.StartsWith("-----", StringComparison.Ordinal)));
        return Convert.FromBase64String(base64);
    }
}

/// <summary>RFC 4648 base64url without padding (what Node's <c>toString('base64url')</c> produces).</summary>
public static class Base64Url
{
    public static byte[] Decode(string value)
    {
        var s = value.Replace('-', '+').Replace('_', '/');
        s = (s.Length % 4) switch
        {
            2 => s + "==",
            3 => s + "=",
            0 => s,
            _ => throw new FormatException("invalid base64url length"),
        };
        return Convert.FromBase64String(s);
    }
}
