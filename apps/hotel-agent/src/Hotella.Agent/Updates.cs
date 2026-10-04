using Hotella.Agent.Core.Security;
using Hotella.Agent.Updater;
using Microsoft.Extensions.Configuration;

namespace Hotella.Agent;

/// <summary>Settings of the self-update (section <c>Updates</c>); without a manifest URL and key, updates are off.</summary>
internal sealed class UpdateSettings
{
    public const string Section = "Updates";

    /// <summary>The release channel's signed manifest, e.g. <c>https://updates.hotella.example/agent/stable.json</c>.</summary>
    public Uri? ManifestUrl { get; set; }

    /// <summary>File holding Planova's update public key (PEM), pinned at install.</summary>
    public string PublicKeyFile { get; set; } = "";

    /// <summary>Apply a newer signed release on its own (otherwise only `hotella-agent update apply`).</summary>
    public bool Auto { get; set; } = true;

    public int CheckHours { get; set; } = 6;

    public static UpdateSettings From(IConfiguration config)
    {
        var settings = new UpdateSettings();
        config.GetSection(Section).Bind(settings);
        return settings;
    }

    /// <summary>The installed layout when the agent runs from versions/&lt;v&gt;/ (installers lay it out so).</summary>
    public static InstallLayout? Layout()
    {
        var running = new DirectoryInfo(AppContext.BaseDirectory.TrimEnd(Path.DirectorySeparatorChar));
        return running.Parent is { Name: "versions", Parent: { } root } ? new InstallLayout(root.FullName) : null;
    }

    public AgentUpdater? Updater()
    {
        var layout = Layout();
        if (layout is null || ManifestUrl is null || !File.Exists(PublicKeyFile)) return null;
        return new AgentUpdater(layout, new CommandSignature(File.ReadAllText(PublicKeyFile)));
    }

    public static Version Running => Version.Parse(Cli.AgentVersion);
}
