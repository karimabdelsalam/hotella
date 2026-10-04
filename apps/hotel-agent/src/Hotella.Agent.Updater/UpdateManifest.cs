using System.Globalization;
using System.Text.Json.Nodes;
using Hotella.Agent.Core.Security;

namespace Hotella.Agent.Updater;

/// <summary>
/// What Planova publishes for each agent release (BUILD_PLAN §10 10.B): version, package location, SHA-256 and size,
/// release channel; Ed25519-signed over its canonical JSON with the update key pinned at install. The <c>typ</c>
/// keeps a manifest from passing as any other signed object.
/// </summary>
public sealed record UpdateManifest(Version Version, Uri Package, string Sha256, long Size, string Channel)
{
    public const string Type = "hotella.agent-update.v1";

    /// <summary>The manifest when the pinned key signed it and it is well formed; null otherwise.</summary>
    public static UpdateManifest? Verify(JsonObject? token, CommandSignature updateKey)
    {
        ArgumentNullException.ThrowIfNull(updateKey);
        if (token is null || !updateKey.Verify(token) || token["typ"]?.GetValue<string>() != Type) return null;
        try
        {
            var sha = token["sha256"]!.GetValue<string>();
            if (sha.Length != 64 || !sha.All(Uri.IsHexDigit)) return null;
            var package = new Uri(token["package_url"]!.GetValue<string>());
            if (package.Scheme != Uri.UriSchemeHttps && !package.IsLoopback) return null;
            return new UpdateManifest(
                Version.Parse(token["version"]!.GetValue<string>()),
                package,
                sha.ToLowerInvariant(),
                // Read from the JSON text: a value built in memory may hold an int, one parsed from text a number.
                long.Parse(token["size"]!.ToJsonString(), NumberStyles.None, CultureInfo.InvariantCulture),
                token["channel"]?.GetValue<string>() ?? "stable");
        }
        catch (Exception e) when (e is FormatException or ArgumentException or InvalidOperationException
                                    or NullReferenceException or OverflowException)
        {
            return null;
        }
    }

    public override string ToString() =>
        string.Create(CultureInfo.InvariantCulture, $"{Version} ({Channel}, {Size} bytes)");
}
