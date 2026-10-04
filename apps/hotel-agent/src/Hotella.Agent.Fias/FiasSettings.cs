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
