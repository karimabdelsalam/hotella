using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace Hotella.Agent.Core.Security;

/// <summary>What the agent keeps after enrollment (ADR-0017 §2). The private key never leaves this machine.</summary>
public sealed record AgentIdentity(
    [property: JsonPropertyName("instance_id")] string InstanceId,
    [property: JsonPropertyName("private_key_pem")] string PrivateKeyPem,
    [property: JsonPropertyName("certificate_pem")] string CertificatePem,
    [property: JsonPropertyName("ca_certificate_pem")] string CaCertificatePem,
    [property: JsonPropertyName("command_public_key_pem")] string CommandPublicKeyPem);

/// <summary>
/// Stores the identity in the agent's data directory, protected by the operating system: DPAPI (machine scope) on
/// Windows; on Linux the directory is 0700 and the file 0600, owned by the service account. Nothing secret is ever
/// written in clear to configuration or logs.
/// </summary>
public sealed class IdentityStore(string dataDirectory)
{
    private static readonly JsonSerializerOptions Json = new() { WriteIndented = true };
    private string FilePath => Path.Combine(dataDirectory, "identity.json");

    public bool Exists => File.Exists(FilePath);

    public void Save(AgentIdentity identity)
    {
        Directory.CreateDirectory(dataDirectory);
        if (!OperatingSystem.IsWindows())
            File.SetUnixFileMode(dataDirectory, UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute);
        var stored = identity with { PrivateKeyPem = Protect(identity.PrivateKeyPem) };
        var tmp = FilePath + ".tmp";
        File.WriteAllText(tmp, JsonSerializer.Serialize(stored, Json));
        if (!OperatingSystem.IsWindows())
            File.SetUnixFileMode(tmp, UnixFileMode.UserRead | UnixFileMode.UserWrite);
        File.Move(tmp, FilePath, overwrite: true);
    }

    public AgentIdentity? Load()
    {
        if (!Exists) return null;
        var stored = JsonSerializer.Deserialize<AgentIdentity>(File.ReadAllText(FilePath))
            ?? throw new InvalidDataException("identity file is empty");
        return stored with { PrivateKeyPem = Unprotect(stored.PrivateKeyPem) };
    }

    private static string Protect(string pem)
    {
        if (!OperatingSystem.IsWindows()) return pem;
        var sealedBytes = ProtectedData.Protect(Encoding.UTF8.GetBytes(pem), null, DataProtectionScope.LocalMachine);
        return "dpapi:" + Convert.ToBase64String(sealedBytes);
    }

    private static string Unprotect(string value)
    {
        if (!value.StartsWith("dpapi:", StringComparison.Ordinal)) return value;
        if (!OperatingSystem.IsWindows()) throw new PlatformNotSupportedException("identity was protected on Windows");
        var bytes = ProtectedData.Unprotect(Convert.FromBase64String(value[6..]), null, DataProtectionScope.LocalMachine);
        return Encoding.UTF8.GetString(bytes);
    }

    /// <summary>True when running on a platform where the identity file permissions are enforced by the OS.</summary>
    public static bool FilePermissionsEnforced => !RuntimeInformation.IsOSPlatform(OSPlatform.Windows);
}
