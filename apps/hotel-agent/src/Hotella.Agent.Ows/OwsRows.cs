using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace Hotella.Agent.Ows;

/// <summary>
/// OWS reservations and profiles → canonical rows of the PMS reads (contracts <c>pms-rows</c>), as the database connector
/// answers them. Reservations in states outside the read contract (waitlist, prospect, request) are not answered, as the
/// database statements leave them out; any other unknown status fails the read rather than being guessed (rule 16).
/// </summary>
public static partial class OwsRows
{
    private static readonly Dictionary<string, string> Statuses = new(StringComparer.Ordinal)
    {
        ["RESERVED"] = "RESERVED",
        ["DUEIN"] = "RESERVED",
        ["CHECKEDIN"] = "IN_HOUSE",
        ["INHOUSE"] = "IN_HOUSE",
        ["DUEOUT"] = "IN_HOUSE",
        ["CHECKEDOUT"] = "CHECKED_OUT",
        ["CANCELED"] = "CANCELLED",
        ["CANCELLED"] = "CANCELLED",
        ["NOSHOW"] = "NO_SHOW",
        ["NO_SHOW"] = "NO_SHOW",
    };

    private static readonly HashSet<string> OutsideContract = new(StringComparer.Ordinal) { "WAITLISTED", "PROSPECT", "REQUESTED" };

    [GeneratedRegex(@"(\d{2}):(\d{2})")]
    private static partial Regex Clock();

    /// <summary>The canonical row, or null for a reservation outside the read contract.</summary>
    public static JsonObject? Reservation(OwsReservation r)
    {
        ArgumentNullException.ThrowIfNull(r);
        if (OutsideContract.Contains(r.Status)) return null;
        if (!Statuses.TryGetValue(r.Status, out var status))
            throw new FormatException($"OWS reservation status {r.Status} is not in the read contract");
        var j = r.Reservation;
        var eta = j["expectedArrivalTime"]?.GetValue<string>() is { } t && Clock().Match(t) is { Success: true } m
            ? $"{m.Groups[1].Value}:{m.Groups[2].Value}"
            : null;
        return new JsonObject
        {
            ["reservation_id"] = r.ReservationId,
            ["confirmation_number"] = Str(j, "confirmationNo"),
            ["status"] = status,
            ["arrival_date"] = Str(j, "arrivalDate") ?? throw new FormatException("reservation without an arrival date"),
            ["departure_date"] = Str(j, "departureDate") ?? throw new FormatException("reservation without a departure date"),
            ["eta"] = eta,
            ["adults"] = j["adults"]?.GetValue<int>() ?? 1,
            ["children"] = j["children"]?.GetValue<int>() ?? 0,
            ["room_number"] = Str(j, "roomNumber"),
            ["room_type"] = null,
            ["rate_code"] = Str(j, "ratePlanCode"),
            ["market_code"] = Str(j, "marketCode"),
            ["profile_id"] = j["guest"]?["profileId"]?.GetValue<string>(),
            ["share_of"] = null,
        };
    }

    public static JsonObject Profile(OwsProfile p)
    {
        ArgumentNullException.ThrowIfNull(p);
        var j = p.Profile;
        return new JsonObject
        {
            ["profile_id"] = Str(j, "profileId") ?? throw new FormatException("profile without an id"),
            ["title"] = Str(j, "title"),
            ["first_name"] = Str(j, "firstName"),
            ["last_name"] = Str(j, "lastName"),
            ["language"] = Str(j, "language"),
            ["vip_code"] = Str(j, "vipCode"),
            ["email"] = p.Emails.Count > 0 ? p.Emails[0] : null,
            ["phone"] = p.Phones.Count > 0 ? p.Phones[0] : null,
        };
    }

    private static string? Str(JsonObject j, string key) =>
        j[key]?.GetValue<string>() is { } v && v.Trim().Length > 0 ? v.Trim() : null;
}
