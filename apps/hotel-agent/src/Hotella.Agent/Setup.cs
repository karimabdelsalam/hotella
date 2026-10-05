using System.Diagnostics;
using System.Globalization;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text.Json.Nodes;
using Hotella.Agent.Core.Hosting;
using Hotella.Agent.Core.Security;

namespace Hotella.Agent;

/// <summary>The operating system's service manager, as far as setup needs it (a fake in tests).</summary>
internal interface IServiceManager
{
    bool Exists(string name);
    void Create(string name, string displayName, string commandLine);
    void Start(string name);
    void Stop(string name);
    void StopAndDelete(string name);
}

/// <summary>Windows: <c>sc.exe</c> — automatic start, restart on any failure (exit 10/11 are restarts too).</summary>
internal sealed class WindowsServiceManager : IServiceManager
{
    public bool Exists(string name) => Sc("query", name) == 0;

    public void Create(string name, string displayName, string commandLine)
    {
        Check(Sc("create", name, "binPath=", commandLine, "start=", "auto", "DisplayName=", displayName));
        Check(Sc("failure", name, "reset=", "86400", "actions=", "restart/5000/restart/5000/restart/30000"));
        Check(Sc("failureflag", name, "1"));
    }

    public void Start(string name) => Sc("start", name);

    public void Stop(string name)
    {
        Sc("stop", name);
        for (var i = 0; i < 60 && Sc("query", name) == 0 && !Stopped(name); i++) Thread.Sleep(500);
    }

    public void StopAndDelete(string name)
    {
        Stop(name);
        Sc("delete", name);
    }

    private static bool Stopped(string name)
    {
        using var p = Process.Start(new ProcessStartInfo("sc.exe", ["query", name])
        {
            RedirectStandardOutput = true,
            UseShellExecute = false,
        })!;
        var output = p.StandardOutput.ReadToEnd();
        p.WaitForExit();
        return output.Contains("STOPPED", StringComparison.Ordinal);
    }

    private static void Check(int exit)
    {
        if (exit != 0) throw new InvalidOperationException($"sc.exe failed ({exit})");
    }

    private static int Sc(params string[] args)
    {
        using var p = Process.Start(new ProcessStartInfo("sc.exe", args)
        {
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
        })!;
        p.StandardOutput.ReadToEnd();
        p.WaitForExit();
        return p.ExitCode;
    }
}

/// <summary>Elsewhere services are the package's business (systemd units come with <c>install.sh</c>).</summary>
internal sealed class NoServiceManager : IServiceManager
{
    public bool Exists(string name) => false;
    public void Create(string name, string displayName, string commandLine) =>
        Console.WriteLine($"service {name}: register it with the system's service manager: {commandLine}");
    public void Start(string name) { }
    public void Stop(string name) { }
    public void StopAndDelete(string name) { }
}

/// <summary>
/// <c>hotella-agent setup install|remove</c> — everything an installer needs, so the MSI (WiX v5, ADR-0020) and
/// <c>install.ps1</c> stay thin shells: the <c>current</c> link, the protected data directory, one service per connector
/// instance enrolled from enrollment codes (the connector and its capabilities come from the platform), and removal.
/// Codes are read from a file, never from the command line; the file is deleted once read.
/// </summary>
internal sealed class Setup(
    IServiceManager services, string dataRoot, string programPath, TextWriter output, Func<string?, bool>? canRun = null)
{
    /// <summary><c>%ProgramFiles%\Hotella\Agent</c> when this program runs from <c>versions\&lt;v&gt;\</c>, else null.</summary>
    public string? InstallRoot
    {
        get
        {
            var dir = Path.GetDirectoryName(programPath)!;
            var versions = Path.GetDirectoryName(dir);
            return versions is not null && Path.GetFileName(versions) == "versions" ? Path.GetDirectoryName(versions) : null;
        }
    }

    private string ServiceProgram => InstallRoot is { } root
        ? Path.Combine(root, "current", Path.GetFileName(programPath))
        : programPath;

    public async Task<int> InstallAsync(string? codesFile, Func<EnrollmentCode, CancellationToken, Task<EnrollmentResult>> enroll,
        CancellationToken ct)
    {
        PointCurrentAtThisVersion();
        Directory.CreateDirectory(dataRoot);
        if (OperatingSystem.IsWindows()) Protect(dataRoot);
        var codes = Array.Empty<EnrollmentCode>();
        if (codesFile is not null && File.Exists(codesFile))
        {
            codes = [.. EnrollmentCode.FindAll(await File.ReadAllTextAsync(codesFile, ct).ConfigureAwait(false))];
            File.Delete(codesFile);
        }
        if (codes.Length == 0 && Instances().Any())
        {
            // An upgrade or repair of a host with enrolled connectors: their services stay as they are.
            foreach (var instance in Instances()) Register(instance);
            StartWhatCanRun();
            output.WriteLine("updated; connector services kept");
            return ExitCodes.Ok;
        }
        if (codes.Length == 0)
        {
            // Single-instance layout (settings in the data root, as install.ps1 always did).
            var example = Path.Combine(Path.GetDirectoryName(programPath)!, "agent.example.json");
            var settings = Path.Combine(dataRoot, "agent.json");
            if (!File.Exists(settings) && File.Exists(example)) File.Copy(example, settings);
            Register(null);
            StartWhatCanRun();
            output.WriteLine($"installed; edit {settings}, enroll, then start the service {AgentHost.ServiceNameOf(null)}");
            return ExitCodes.Ok;
        }
        var failed = 0;
        foreach (var code in codes)
        {
            try
            {
                var result = await enroll(code, ct).ConfigureAwait(false);
                var connector = result.ConnectorCode
                    ?? throw new InvalidOperationException("the platform did not say which connector this is; update it");
                var instance = InstanceName(connector);
                var dir = Path.Combine(dataRoot, "instances", instance);
                Directory.CreateDirectory(dir);
                var store = new IdentityStore(dir);
                if (store.Exists)
                {
                    output.WriteLine($"{instance}: already enrolled; kept (revoke and use a new code to replace it)");
                }
                else
                {
                    store.Save(result.Identity);
                    WriteSettings(dir, code.Gateway, connector, result.Capabilities);
                    output.WriteLine($"{instance}: enrolled as instance {result.Identity.InstanceId}");
                }
                Register(instance);
            }
#pragma warning disable CA1031 // One bad code must not stop the others; the installer reports each.
            catch (Exception e)
#pragma warning restore CA1031
            {
                failed++;
                output.WriteLine($"an enrollment code was refused: {Describe(e)}");
            }
        }
        StartWhatCanRun();
        output.WriteLine("next: set each connector's settings and secrets (hotella-agent status --instance <name>), then start its service");
        return failed == 0 ? ExitCodes.Ok : ExitCodes.Refused;
    }

    /// <summary>Stops every Hotella agent service of this host (before an installer replaces files).</summary>
    public int Stop()
    {
        foreach (var name in ServiceNames()) if (services.Exists(name)) services.Stop(name);
        return ExitCodes.Ok;
    }

    /// <summary>Services whose settings are complete start now; the others wait for their settings.</summary>
    private void StartWhatCanRun()
    {
        foreach (var instance in Instances().Cast<string?>().Append(null))
        {
            var name = AgentHost.ServiceNameOf(instance);
            if (services.Exists(name) && (canRun?.Invoke(instance) ?? false)) services.Start(name);
        }
    }

    private IEnumerable<string> ServiceNames() =>
        Instances().Select(AgentHost.ServiceNameOf).Append(AgentHost.ServiceNameOf(null));

    public int Remove(bool removeData)
    {
        foreach (var name in ServiceNames()) if (services.Exists(name)) services.StopAndDelete(name);
        if (InstallRoot is { } root)
        {
            var current = Path.Combine(root, "current");
            if (Directory.Exists(current) || File.Exists(current)) Directory.Delete(current);
            // Versions the self-updater added; the installer removes its own files itself.
            var mine = Path.GetDirectoryName(programPath)!;
            foreach (var v in Directory.EnumerateDirectories(Path.Combine(root, "versions")))
                if (!string.Equals(Path.GetFullPath(v), Path.GetFullPath(mine), StringComparison.OrdinalIgnoreCase))
                    Directory.Delete(v, recursive: true);
        }
        if (removeData && Directory.Exists(dataRoot)) Directory.Delete(dataRoot, recursive: true);
        output.WriteLine(removeData ? "removed, including the agent's identity and queue" : "removed; identity and queue kept");
        return ExitCodes.Ok;
    }

    /// <summary><c>OPERA5_FIAS</c> → <c>opera5-fias</c>.</summary>
    public static string InstanceName(string connectorCode) =>
        connectorCode.ToLowerInvariant().Replace('_', '-');

    private IEnumerable<string> Instances()
    {
        var dir = Path.Combine(dataRoot, "instances");
        return Directory.Exists(dir)
            ? Directory.EnumerateDirectories(dir).Select(Path.GetFileName).OfType<string>().Where(AgentHost.IsInstanceName)
            : [];
    }

    private void Register(string? instance)
    {
        var name = AgentHost.ServiceNameOf(instance);
        if (services.Exists(name)) return;
        var command = $"\"{ServiceProgram}\" run" + (instance is null ? "" : $" --instance {instance}")
            + (string.Equals(Path.GetFullPath(dataRoot), Path.GetFullPath(AgentSettings.DefaultDataDirectory()),
                StringComparison.OrdinalIgnoreCase) ? "" : $" --data-root \"{dataRoot}\"");
        services.Create(name, instance is null ? "Hotella hotel agent" : $"Hotella hotel agent ({instance})", command);
    }

    private void PointCurrentAtThisVersion()
    {
        if (InstallRoot is not { } root) return;
        var current = Path.Combine(root, "current");
        var target = Path.GetDirectoryName(programPath)!;
        if (Directory.Exists(current) || File.Exists(current)) Directory.Delete(current);
        Directory.CreateSymbolicLink(current, target);
    }

    private static void WriteSettings(string dir, Uri gateway, string connector, IReadOnlyList<string> capabilities)
    {
        var settings = new JsonObject
        {
            ["Agent"] = new JsonObject
            {
                ["Gateway"] = gateway.ToString(),
                ["ConnectorCode"] = connector,
                ["Capabilities"] = new JsonArray([.. capabilities.Select(c => (JsonNode)c)]),
            },
        };
        File.WriteAllText(Path.Combine(dir, "agent.json"),
            settings.ToJsonString(new System.Text.Json.JsonSerializerOptions { WriteIndented = true }));
    }

    /// <summary>The data directory holds device identities: SYSTEM and Administrators only, nothing inherited.</summary>
    [System.Runtime.Versioning.SupportedOSPlatform("windows")]
    private static void Protect(string dir)
    {
        var security = new DirectorySecurity();
        security.SetAccessRuleProtection(isProtected: true, preserveInheritance: false);
        foreach (var sid in new[] { WellKnownSidType.LocalSystemSid, WellKnownSidType.BuiltinAdministratorsSid })
            security.AddAccessRule(new FileSystemAccessRule(new SecurityIdentifier(sid, null), FileSystemRights.FullControl,
                InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit, PropagationFlags.None,
                AccessControlType.Allow));
        new DirectoryInfo(dir).SetAccessControl(security);
    }

    private static string Describe(Exception e) => e switch
    {
        GatewayHttpException g => string.Create(CultureInfo.InvariantCulture, $"{g.Code} (HTTP {g.Status}); ask for a new code"),
        FormatException or System.Security.Cryptography.CryptographicException => e.Message,
        HttpRequestException => $"the platform could not be reached ({e.Message})",
        _ => e.GetType().Name,
    };
}
