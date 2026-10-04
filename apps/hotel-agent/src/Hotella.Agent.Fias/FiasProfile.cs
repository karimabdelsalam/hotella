namespace Hotella.Agent.Fias;

/// <summary>
/// Planova Standard OPERA IFC8/FIAS Profile v1 (guide §7.3): the records and fields the agent requests with LR. The
/// platform's definition (<c>FIAS_STANDARD_PROFILE_V1</c> in contracts-connectors) is the source; the shared vector
/// <c>fias-profile-v1.json</c> proves both sides request the same thing. Fields a hotel does not deliver show as profile
/// gaps on the platform, never as guesses here.
/// </summary>
public static class FiasProfile
{
    public const string Code = "PLANOVA_FIAS_STANDARD";
    public const int Version = 1;

    /// <summary>Always requested.</summary>
    public static readonly IReadOnlyList<(string Record, string Fields)> Standard =
    [
        ("GI", "RNG#GNGFGTGLGVGSGGGAGDSFDATI"),
        ("GO", "RNG#GSSFDATI"),
        ("GC", "RNROG#GNGFGTGLGVGSGGGAGDDATI"),
        ("RE", "RNRSDATI"),
        ("DS", "DATI"),
        ("DE", "DATI"),
    ];

    /// <summary>Requested only when the hotel enables them (<c>Fias:OptionalRecords</c>).</summary>
    public static readonly IReadOnlyList<(string Record, string Fields)> Optional =
    [
        ("NS", "DATI"),
        ("NE", "DATI"),
    ];

    /// <summary>The LR requests for this hotel: the standard records, then the enabled optional ones.</summary>
    public static IReadOnlyList<(string Record, string Fields)> LinkRecords(IEnumerable<string> enabledOptional)
    {
        var enabled = enabledOptional.ToHashSet(StringComparer.Ordinal);
        return [.. Standard, .. Optional.Where(o => enabled.Contains(o.Record))];
    }
}
