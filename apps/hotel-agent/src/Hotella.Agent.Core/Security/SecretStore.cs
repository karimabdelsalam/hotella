using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace Hotella.Agent.Core.Security;

/// <summary>
/// Credentials the agent needs at the hotel (e.g. the OWS user's password), kept like the device key (BUILD_PLAN §10
/// 10.B): DPAPI (machine scope) on Windows, a 0600 file in the 0700 data directory on Linux. Never in settings files,
/// logs or messages to the platform. Set with <c>hotella-agent secret set &lt;name&gt;</c> from stdin.
/// </summary>
public sealed class SecretStore(string dataDirectory)
{
    private static readonly JsonSerializerOptions Json = new() { WriteIndented = true };
    private string FilePath => Path.Combine(dataDirectory, "secrets.json");

    public string? Get(string name)
    {
        var all = Read();
        return all.TryGetValue(name, out var sealedValue) ? Unprotect(sealedValue) : null;
    }

    public void Set(string name, string value)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(name);
        ArgumentNullException.ThrowIfNull(value);
        var all = Read();
        all[name] = Protect(value);
        Write(all);
    }

    public bool Remove(string name)
    {
        var all = Read();
        if (!all.Remove(name)) return false;
        Write(all);
        return true;
    }

    /// <summary>Names only — for `status`; values are never listed.</summary>
    public IReadOnlyList<string> Names() => [.. Read().Keys.Order(StringComparer.Ordinal)];

    private Dictionary<string, string> Read() =>
        File.Exists(FilePath)
            ? JsonSerializer.Deserialize<Dictionary<string, string>>(File.ReadAllText(FilePath)) ?? []
            : [];

    private void Write(Dictionary<string, string> all)
    {
        Directory.CreateDirectory(dataDirectory);
        if (!OperatingSystem.IsWindows())
            File.SetUnixFileMode(dataDirectory, UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute);
        var tmp = FilePath + ".tmp";
        File.WriteAllText(tmp, JsonSerializer.Serialize(all, Json));
        if (!OperatingSystem.IsWindows()) File.SetUnixFileMode(tmp, UnixFileMode.UserRead | UnixFileMode.UserWrite);
        File.Move(tmp, FilePath, overwrite: true);
    }

    private static string Protect(string value)
    {
        if (!OperatingSystem.IsWindows()) return value;
        var sealedBytes = ProtectedData.Protect(Encoding.UTF8.GetBytes(value), null, DataProtectionScope.LocalMachine);
        return "dpapi:" + Convert.ToBase64String(sealedBytes);
    }

    private static string Unprotect(string value)
    {
        if (!value.StartsWith("dpapi:", StringComparison.Ordinal)) return value;
        if (!OperatingSystem.IsWindows()) throw new PlatformNotSupportedException("secret was protected on Windows");
        return Encoding.UTF8.GetString(
            ProtectedData.Unprotect(Convert.FromBase64String(value[6..]), null, DataProtectionScope.LocalMachine));
    }
}
