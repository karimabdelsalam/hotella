using System.Globalization;
using System.Text.Json.Nodes;
using Hotella.Agent.Core.Security;

namespace Hotella.Agent.Core.Licensing;

public enum LicenceState
{
    /// <summary>No licence received yet (a fresh install before its first welcome).</summary>
    Missing,
    Valid,

    /// <summary>Expired but within the offline grace: everything keeps working; staff are warned.</summary>
    Grace,

    /// <summary>Past the grace: PMS records are still buffered, but no command runs until a fresh licence arrives.</summary>
    Expired,
}

/// <summary>The licence the platform signed for this agent (Spec §62), as kept on disk and verified offline.</summary>
public sealed record Licence(
    string InstanceId,
    string ConnectorCode,
    IReadOnlyList<string> Capabilities,
    DateTimeOffset IssuedAt,
    DateTimeOffset ExpiresAt,
    int GraceDays,
    JsonObject Token)
{
    public const string Type = "hotella.licence.v1";

    /// <summary>Deterministic state at an instant (never delegated: CLAUDE.md rule 11).</summary>
    public LicenceState StateAt(DateTimeOffset now) =>
        now < ExpiresAt ? LicenceState.Valid
        : now < ExpiresAt.AddDays(GraceDays) ? LicenceState.Grace
        : LicenceState.Expired;

    /// <summary>
    /// Accepts a licence only when the pinned platform key signed it, it is a licence (not some other signed object) and
    /// it is this instance's; returns null otherwise.
    /// </summary>
    public static Licence? Verify(JsonObject? token, CommandSignature key, string instanceId)
    {
        ArgumentNullException.ThrowIfNull(key);
        if (token is null || !key.Verify(token)) return null;
        if (token["typ"]?.GetValue<string>() != Type) return null;
        if (token["instance_id"]?.GetValue<string>() != instanceId) return null;
        try
        {
            return new Licence(
                instanceId,
                token["connector_code"]!.GetValue<string>(),
                token["capabilities"]!.AsArray().Select(c => c!.GetValue<string>()).ToList(),
                DateTimeOffset.Parse(token["issued_at"]!.GetValue<string>(), CultureInfo.InvariantCulture),
                DateTimeOffset.Parse(token["expires_at"]!.GetValue<string>(), CultureInfo.InvariantCulture),
                token["grace_days"]!.GetValue<int>(),
                (JsonObject)token.DeepClone());
        }
        catch (Exception e) when (e is FormatException or InvalidOperationException or NullReferenceException)
        {
            return null;
        }
    }
}

/// <summary>
/// The latest licence, kept in the data directory (signed, not secret) and re-verified on every load so a hand-edited
/// file is worthless. A newer licence replaces an older one, never the other way round.
/// </summary>
public sealed class LicenceStore(string dataDirectory, CommandSignature key, string instanceId)
{
    private readonly Lock _lock = new();
    private Licence? _current;
    private bool _loaded;
    private string FilePath => Path.Combine(dataDirectory, "licence.json");

    public Licence? Current
    {
        get
        {
            lock (_lock)
            {
                if (!_loaded)
                {
                    _loaded = true;
                    if (File.Exists(FilePath))
                        _current = Licence.Verify(JsonNode.Parse(File.ReadAllText(FilePath)) as JsonObject, key, instanceId);
                }
                return _current;
            }
        }
    }

    public LicenceState StateAt(DateTimeOffset now) => Current?.StateAt(now) ?? LicenceState.Missing;

    /// <summary>Keeps a verified licence if it is newer than the one held; returns whether it was taken.</summary>
    public bool Offer(JsonObject? token)
    {
        var licence = Licence.Verify(token, key, instanceId);
        if (licence is null) return false;
        lock (_lock)
        {
            var held = Current;
            if (held is not null && held.IssuedAt >= licence.IssuedAt) return false;
            Directory.CreateDirectory(dataDirectory);
            var tmp = FilePath + ".tmp";
            File.WriteAllText(tmp, licence.Token.ToJsonString());
            File.Move(tmp, FilePath, overwrite: true);
            _current = licence;
            return true;
        }
    }

    /// <summary>Why a command may not run now, or null when it may.</summary>
    public string? CommandRefusal(DateTimeOffset now) => StateAt(now) switch
    {
        LicenceState.Missing => "no licence received from the platform yet",
        LicenceState.Expired => "licence expired past its grace; commands wait for a fresh licence",
        _ => null,
    };
}
