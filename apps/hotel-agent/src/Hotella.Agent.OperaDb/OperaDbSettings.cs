using System.Text.RegularExpressions;

namespace Hotella.Agent.OperaDb;

/// <summary>
/// Settings of the OPERA read-only database connector (section <c>OperaDb</c>, guide §6). The account's password is a
/// secret in the agent's protected store (<c>hotella-agent secret set opera.db.password</c>), never in this file.
/// </summary>
public sealed partial class OperaDbSettings
{
    public const string Section = "OperaDb";

    /// <summary><c>oracle</c> (the hotel's OPERA database) or <c>fixture</c> (a JSON file: development and CI only).</summary>
    public string Provider { get; set; } = "oracle";

    public string Host { get; set; } = "";
    public int Port { get; set; } = 1521;
    public string ServiceName { get; set; } = "";

    /// <summary>The dedicated SELECT-only account (e.g. <c>HOTELLA_RO</c>), never the OPERA schema owner.</summary>
    public string Username { get; set; } = "";
    public string PasswordSecret { get; set; } = "opera.db.password";

    /// <summary>Owner of the OPERA tables (commonly <c>OPERA</c>) and the hotel's resort code.</summary>
    public string SchemaOwner { get; set; } = "OPERA";
    public string ResortCode { get; set; } = "";

    public int QueryTimeoutSeconds { get; set; } = 30;

    /// <summary>Fallback change polling of the arrival window (only when OWS is absent, guide §6.5).</summary>
    public bool ChangePolling { get; set; }
    public int PollSeconds { get; set; } = 300;
    public int WindowDays { get; set; } = 14;

    /// <summary>The fixture provider's file.</summary>
    public string? FixturePath { get; set; }

    [GeneratedRegex("^[A-Z][A-Z0-9_$#]{0,29}$")]
    private static partial Regex OracleIdentifier();

    public static bool IsIdentifier(string value) => OracleIdentifier().IsMatch(value);

    public IReadOnlyList<string> Problems()
    {
        var problems = new List<string>();
        if (Provider is not ("oracle" or "fixture")) problems.Add("OperaDb:Provider must be oracle or fixture");
        if (Provider == "oracle")
        {
            if (string.IsNullOrWhiteSpace(Host)) problems.Add("OperaDb:Host is not set");
            if (string.IsNullOrWhiteSpace(ServiceName)) problems.Add("OperaDb:ServiceName is not set");
            if (string.IsNullOrWhiteSpace(Username)) problems.Add("OperaDb:Username is not set");
        }
        if (Provider == "fixture" && string.IsNullOrWhiteSpace(FixturePath)) problems.Add("OperaDb:FixturePath is not set");
        // The owner is the only identifier written into the statements (it cannot be a bind variable): strictly checked.
        if (!IsIdentifier(SchemaOwner)) problems.Add("OperaDb:SchemaOwner must be an upper-case Oracle identifier");
        if (string.IsNullOrWhiteSpace(ResortCode)) problems.Add("OperaDb:ResortCode is not set");
        if (QueryTimeoutSeconds is < 1 or > 30) problems.Add("OperaDb:QueryTimeoutSeconds must be between 1 and 30");
        if (PollSeconds < 60) problems.Add("OperaDb:PollSeconds must be at least 60");
        if (WindowDays is < 1 or > 31) problems.Add("OperaDb:WindowDays must be between 1 and 31");
        return problems;
    }
}
