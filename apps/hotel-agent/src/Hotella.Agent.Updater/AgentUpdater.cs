using System.Globalization;
using System.IO.Compression;
using System.Security.Cryptography;
using System.Text.Json;
using System.Runtime.InteropServices;
using System.Text.Json.Nodes;
using Hotella.Agent.Core.Security;

namespace Hotella.Agent.Updater;

public enum UpdateStatus
{
    None,
    Probation,
    Confirmed,
    RolledBack,
}

/// <summary>Where the agent is installed: <c>versions/&lt;v&gt;/</c> side by side and <c>current</c> → the running one.</summary>
public sealed record InstallLayout(string Root)
{
    public string Versions => Path.Combine(Root, "versions");
    public string Current => Path.Combine(Root, "current");
    public string StateFile => Path.Combine(Root, "update-state.json");
    public string VersionDirectory(Version v) => Path.Combine(Versions, v.ToString());
}

/// <summary>The updater's memory across restarts (update-state.json beside the versions).</summary>
public sealed record UpdateState(
    UpdateStatus Status, string? Previous, string? Candidate, DateTimeOffset? SwitchedAt, int Starts,
    IReadOnlyList<string> Blocked, string? Reason)
{
    public static readonly UpdateState Empty = new(UpdateStatus.None, null, null, null, 0, [], null);
}

/// <summary>
/// The agent's signed self-update with probation and rollback (BUILD_PLAN §10 10.B "Updates"): verify the manifest
/// with the pinned key, download the package and check its size and SHA-256, unpack it beside the running version,
/// switch <c>current</c>, and let the service manager restart into it. The new version is on probation: it confirms
/// itself once its link is up; if it fails to start <see cref="MaxStarts"/> times or stays unhealthy past
/// <see cref="Probation"/>, <c>current</c> goes back to the previous version and the candidate is blocked. It never
/// touches OPERA, the data directory or the identity.
/// </summary>
public sealed class AgentUpdater(InstallLayout layout, CommandSignature updateKey, HttpMessageHandler? handler = null)
{
    public const int MaxStarts = 3;
    public static readonly TimeSpan Probation = TimeSpan.FromMinutes(10);
    private static readonly JsonSerializerOptions Json = new() { WriteIndented = true };

    public UpdateState State =>
        File.Exists(layout.StateFile)
            ? JsonSerializer.Deserialize<UpdateState>(File.ReadAllText(layout.StateFile), Json) ?? UpdateState.Empty
            : UpdateState.Empty;

    /// <summary>A verified manifest newer than <paramref name="running"/> and not blocked, or null.</summary>
    public async Task<UpdateManifest?> CheckAsync(Uri manifestUrl, Version running, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(running);
        using var http = Client();
        var token = JsonNode.Parse(await http.GetStringAsync(manifestUrl, ct).ConfigureAwait(false)) as JsonObject;
        var manifest = UpdateManifest.Verify(token, updateKey)
            ?? throw new InvalidDataException("update manifest is not signed by the pinned update key");
        if (manifest.Version <= running) return null;
        return State.Blocked.Contains(manifest.Version.ToString()) ? null : manifest;
    }

    /// <summary>Downloads, verifies and unpacks the package beside the running version; returns its directory.</summary>
    public async Task<string> StageAsync(UpdateManifest manifest, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(manifest);
        var target = layout.VersionDirectory(manifest.Version);
        if (Directory.Exists(target)) return target;
        Directory.CreateDirectory(layout.Versions);
        var download = Path.Combine(layout.Versions, $".{manifest.Version}.zip");
        var staging = target + ".staging";
        try
        {
            using var http = Client();
            using (var response = await http.GetAsync(manifest.Package, HttpCompletionOption.ResponseHeadersRead, ct)
                       .ConfigureAwait(false))
            {
                response.EnsureSuccessStatusCode();
                await using var file = File.Create(download);
                await using var body = await response.Content.ReadAsStreamAsync(ct).ConfigureAwait(false);
                await CopyLimitedAsync(body, file, manifest.Size, ct).ConfigureAwait(false);
            }
            var info = new FileInfo(download);
            if (info.Length != manifest.Size) throw new InvalidDataException("update package has the wrong size");
            await using (var check = File.OpenRead(download))
            {
                var sha = Convert.ToHexStringLower(await SHA256.HashDataAsync(check, ct).ConfigureAwait(false));
                if (sha != manifest.Sha256) throw new InvalidDataException("update package does not match its SHA-256");
            }
            if (Directory.Exists(staging)) Directory.Delete(staging, recursive: true);
            // ExtractToDirectory refuses entries that would land outside the target (path traversal).
            await ZipFile.ExtractToDirectoryAsync(download, staging, overwriteFiles: false, ct).ConfigureAwait(false);
            Directory.Move(staging, target);
            return target;
        }
        finally
        {
            if (File.Exists(download)) File.Delete(download);
            if (Directory.Exists(staging)) Directory.Delete(staging, recursive: true);
        }
    }

    /// <summary>Points <c>current</c> at the staged version and starts its probation; the caller restarts the service.</summary>
    public void Switch(Version candidate, Version running, DateTimeOffset now)
    {
        ArgumentNullException.ThrowIfNull(candidate);
        ArgumentNullException.ThrowIfNull(running);
        PointCurrentAt(layout.VersionDirectory(candidate));
        Save(State with
        {
            Status = UpdateStatus.Probation, Previous = running.ToString(), Candidate = candidate.ToString(),
            SwitchedAt = now, Starts = 0, Reason = null,
        });
    }

    /// <summary>
    /// Called first thing at every start. Returns false when this start must not proceed because the candidate failed
    /// too often and <c>current</c> was switched back (the service manager restarts into the previous version).
    /// </summary>
    public bool OnStartup(Version running, DateTimeOffset now)
    {
        ArgumentNullException.ThrowIfNull(running);
        var state = State;
        if (state.Status != UpdateStatus.Probation || state.Candidate != running.ToString()) return true;
        if (state.Starts + 1 > MaxStarts || ProbationOver(state, now))
        {
            Rollback(state.Starts + 1 > MaxStarts ? "the new version failed to start" : "the new version stayed unhealthy");
            return false;
        }
        Save(state with { Starts = state.Starts + 1 });
        return true;
    }

    /// <summary>The running candidate is healthy: it stays.</summary>
    public void Confirm(Version running)
    {
        ArgumentNullException.ThrowIfNull(running);
        var state = State;
        if (state.Status == UpdateStatus.Probation && state.Candidate == running.ToString())
            Save(state with { Status = UpdateStatus.Confirmed, Starts = 0 });
    }

    /// <summary>True when the running candidate's probation has run out without a confirmation.</summary>
    public bool ProbationFailed(Version running, DateTimeOffset now)
    {
        ArgumentNullException.ThrowIfNull(running);
        var state = State;
        return state.Status == UpdateStatus.Probation && state.Candidate == running.ToString() && ProbationOver(state, now);
    }

    /// <summary>Back to the previous version; the candidate is blocked until a newer release.</summary>
    public void Rollback(string reason)
    {
        var state = State;
        if (state.Previous is null) throw new InvalidOperationException("no previous version to go back to");
        PointCurrentAt(Path.Combine(layout.Versions, state.Previous));
        Save(state with
        {
            Status = UpdateStatus.RolledBack,
            Blocked = state.Candidate is null || state.Blocked.Contains(state.Candidate)
                ? state.Blocked : [.. state.Blocked, state.Candidate],
            Reason = reason,
        });
    }

    private static bool ProbationOver(UpdateState state, DateTimeOffset now) =>
        state.SwitchedAt is { } at && now - at > Probation;

    /// <summary>Atomic on Linux (rename over the old link); on Windows the link is replaced in two steps.</summary>
    private void PointCurrentAt(string versionDirectory)
    {
        if (!Directory.Exists(versionDirectory)) throw new DirectoryNotFoundException(versionDirectory);
        var tmp = layout.Current + ".next";
        if (File.Exists(tmp) || Directory.Exists(tmp)) Directory.Delete(tmp);
        Directory.CreateSymbolicLink(tmp, versionDirectory);
        if (OperatingSystem.IsWindows())
        {
            if (Directory.Exists(layout.Current)) Directory.Delete(layout.Current);
            Directory.Move(tmp, layout.Current);
        }
        else if (Posix.Rename(tmp, layout.Current) != 0)
            throw new IOException($"could not switch {layout.Current} (errno {Marshal.GetLastPInvokeError()})");
    }

    private void Save(UpdateState state)
    {
        Directory.CreateDirectory(layout.Root);
        var tmp = layout.StateFile + ".tmp";
        File.WriteAllText(tmp, JsonSerializer.Serialize(state, Json));
        File.Move(tmp, layout.StateFile, overwrite: true);
    }

    private HttpClient Client() =>
        handler is null ? new HttpClient { Timeout = TimeSpan.FromMinutes(5) } : new HttpClient(handler, disposeHandler: false);

    private static async Task CopyLimitedAsync(Stream from, Stream to, long limit, CancellationToken ct)
    {
        var buffer = new byte[81920];
        long total = 0;
        int read;
        while ((read = await from.ReadAsync(buffer, ct).ConfigureAwait(false)) > 0)
        {
            total += read;
            if (total > limit) throw new InvalidDataException("update package is larger than its manifest says");
            await to.WriteAsync(buffer.AsMemory(0, read), ct).ConfigureAwait(false);
        }
    }

    /// <summary>For status output.</summary>
    public static string Describe(UpdateState state) =>
        state.Status switch
        {
            UpdateStatus.None => "no update applied",
            UpdateStatus.Probation => string.Create(CultureInfo.InvariantCulture,
                $"{state.Candidate} on probation since {state.SwitchedAt:u} ({state.Starts} start(s)); previous {state.Previous}"),
            UpdateStatus.Confirmed => $"{state.Candidate} confirmed (previous {state.Previous} kept)",
            _ => $"rolled back to {state.Previous}: {state.Reason}; blocked: {string.Join(", ", state.Blocked)}",
        };
}

/// <summary>rename(2) replaces the old link in one step, so <c>current</c> always points at a complete version.</summary>
internal static partial class Posix
{
    [LibraryImport("libc", EntryPoint = "rename", StringMarshalling = StringMarshalling.Utf8, SetLastError = true)]
    internal static partial int Rename(string from, string to);
}
