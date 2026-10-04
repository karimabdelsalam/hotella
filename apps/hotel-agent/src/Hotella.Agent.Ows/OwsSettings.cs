namespace Hotella.Agent.Ows;

/// <summary>Settings of the OWS poller (section <c>Ows</c>). The password is a secret in the agent's protected store.</summary>
public sealed class OwsSettings
{
    public const string Section = "Ows";

    /// <summary>Base address of the hotel's OWS, e.g. <c>https://opera.hotel.local/OWS_WS_51/</c>.</summary>
    public Uri? Url { get; set; }

    public string Username { get; set; } = "";

    /// <summary>Name of the secret holding the OWS user's password (<c>hotella-agent secret set ows.password</c>).</summary>
    public string PasswordSecret { get; set; } = "ows.password";

    /// <summary>OGHeader authentication domain and the hotel reference OPERA expects.</summary>
    public string Domain { get; set; } = "";
    public string HotelCode { get; set; } = "";
    public string ChainCode { get; set; } = "";
    public string OriginEntity { get; set; } = "HOTELLA";
    public string DestinationEntity { get; set; } = "TI";

    /// <summary>How often the arrival window is polled, and how far ahead it reaches.</summary>
    public int PollSeconds { get; set; } = 300;
    public int WindowDays { get; set; } = 14;
    public int TimeoutSeconds { get; set; } = 60;

    public IReadOnlyList<string> Problems()
    {
        var problems = new List<string>();
        if (Url is null) problems.Add("Ows:Url is not set");
        else if (Url.Scheme != Uri.UriSchemeHttps && !Url.IsLoopback) problems.Add("Ows:Url must be https:// (loopback excepted)");
        if (string.IsNullOrWhiteSpace(Username)) problems.Add("Ows:Username is not set");
        if (string.IsNullOrWhiteSpace(HotelCode)) problems.Add("Ows:HotelCode is not set");
        if (PollSeconds < 30) problems.Add("Ows:PollSeconds must be at least 30");
        if (WindowDays is < 1 or > 365) problems.Add("Ows:WindowDays must be between 1 and 365");
        return problems;
    }
}
