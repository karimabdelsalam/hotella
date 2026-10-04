using System.Text;

namespace Hotella.Agent.Fias;

/// <summary>Who opens the TCP connection: IFC8 can be set up either way; the hotel's interface sheet says which.</summary>
public enum FiasConnectMode
{
    /// <summary>The agent connects to IFC8's host and port.</summary>
    Client,

    /// <summary>The agent listens and IFC8 connects to it.</summary>
    Server,
}

/// <summary>Settings of the IFC8 link (section <c>Fias</c>). FIAS over TCP has no credentials.</summary>
public sealed class FiasSettings
{
    public const string Section = "Fias";

    public FiasConnectMode Mode { get; set; } = FiasConnectMode.Client;

    /// <summary>IFC8's address (Client) or the address to listen on (Server).</summary>
    public string Host { get; set; } = "";

    public int Port { get; set; }

    /// <summary>Character set IFC8 is configured with (utf-8, windows-1252, iso-8859-1, …).</summary>
    public string Encoding { get; set; } = "utf-8";

    /// <summary>An idle link sends LA this often; nothing heard for three intervals means the link is dead.</summary>
    public int LinkAliveSeconds { get; set; } = 60;

    /// <summary>Without IFC8's LS this long after connecting, the agent starts the link itself.</summary>
    public int LinkStartSeconds { get; set; } = 10;

    public int ReconnectSeconds { get; set; } = 5;

    /// <summary>
    /// Optional records of the standard profile to request as well (guide §7.3): <c>NS</c>, <c>NE</c> (night audit).
    /// Only when the hotel's IFC8 sends them for this interface.
    /// </summary>
    public IList<string> OptionalRecords { get; set; } = [];

    /// <summary>After the link was down this long, the agent asks IFC8 for a database swap (DR) once it is back; 0 = never.</summary>
    public int ResyncAfterOutageSeconds { get; set; } = 300;

    /// <summary>A command waits at most this long for a running database swap to end (nothing is sent during a swap).</summary>
    public int SwapWaitSeconds { get; set; } = 120;

    public Encoding TextEncoding()
    {
        System.Text.Encoding.RegisterProvider(CodePagesEncodingProvider.Instance);
        return System.Text.Encoding.GetEncoding(Encoding);
    }

    public IReadOnlyList<string> Problems()
    {
        var problems = new List<string>();
        if (Mode == FiasConnectMode.Client && string.IsNullOrWhiteSpace(Host)) problems.Add("Fias:Host is not set");
        if (Port is < 1 or > 65535) problems.Add("Fias:Port must be a TCP port");
        if (LinkAliveSeconds < 5) problems.Add("Fias:LinkAliveSeconds must be at least 5");
        foreach (var r in OptionalRecords.Where(r => !FiasProfile.Optional.Any(o => o.Record == r)))
            problems.Add($"Fias:OptionalRecords: {r} is not an optional record of the standard profile");
        if (ResyncAfterOutageSeconds < 0) problems.Add("Fias:ResyncAfterOutageSeconds must not be negative");
        if (SwapWaitSeconds is < 1 or > 600) problems.Add("Fias:SwapWaitSeconds must be between 1 and 600");
        try
        {
            TextEncoding();
        }
        catch (ArgumentException)
        {
            problems.Add("Fias:Encoding is not a known character set");
        }
        return problems;
    }
}
