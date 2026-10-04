using System.Globalization;
using System.Text.Json.Nodes;

namespace Hotella.Agent.OperaDb;

/// <summary>
/// OPERA rows → canonical rows of the PMS reads (contracts `pms-rows`): reservation, profile, room. Statuses outside
/// the contract never reach here (the statements filter them); a value of the wrong shape fails the read rather than
/// being guessed (rule 16).
/// </summary>
public static class RowMapper
{
    public static JsonObject Reservation(DbRow r)
    {
        ArgumentNullException.ThrowIfNull(r);
        var status = Text(r["RESV_STATUS"]) ?? throw new FormatException("reservation without a status");
        if (!DataContract.Statuses.TryGetValue(status, out var canonical))
            throw new FormatException($"reservation status {status} is not in data contract v{DataContract.Version}");
        return new JsonObject
        {
            ["reservation_id"] = Text(r["RESV_NAME_ID"]) ?? throw new FormatException("reservation without an id"),
            ["confirmation_number"] = Text(r["CONFIRMATION_NO"]),
            ["status"] = canonical,
            ["arrival_date"] = Day(r["ARRIVAL_DATE"]) ?? throw new FormatException("reservation without an arrival date"),
            ["departure_date"] = Day(r["DEPARTURE_DATE"]) ?? throw new FormatException("reservation without a departure date"),
            ["eta"] = Clock(r["ETA"]),
            ["adults"] = Count(r["ADULTS"], 1),
            ["children"] = Count(r["CHILDREN"], 0),
            ["room_number"] = Text(r["ROOM"]),
            ["room_type"] = Text(r["ROOM_CATEGORY"]),
            ["rate_code"] = Text(r["RATE_CODE"]),
            ["market_code"] = Text(r["MARKET_CODE"]),
            ["profile_id"] = Text(r["NAME_ID"]),
            ["share_of"] = Text(r["SHARE_OF"]),
        };
    }

    public static JsonObject Profile(DbRow r)
    {
        ArgumentNullException.ThrowIfNull(r);
        return new JsonObject
        {
            ["profile_id"] = Text(r["NAME_ID"]) ?? throw new FormatException("profile without an id"),
            ["title"] = Text(r["TITLE"]),
            ["first_name"] = Text(r["FIRST"]),
            ["last_name"] = Text(r["LAST"]),
            ["language"] = Text(r["LANGUAGE"]),
            ["vip_code"] = Text(r["VIP_STATUS"]),
            ["email"] = Text(r["EMAIL"]),
            ["phone"] = Text(r["PHONE"]),
        };
    }

    public static JsonObject Room(DbRow r)
    {
        ArgumentNullException.ThrowIfNull(r);
        return new JsonObject
        {
            ["room_number"] = Text(r["ROOM"]) ?? throw new FormatException("room without a number"),
            ["room_type"] = Text(r["ROOM_CATEGORY"]),
            ["floor"] = Text(r["FLOOR"]),
        };
    }

    internal static string? Text(object? v) => v switch
    {
        null or DBNull => null,
        string s => s.Trim().Length == 0 ? null : s.Trim(),
        IFormattable f => f.ToString(null, CultureInfo.InvariantCulture),
        _ => v.ToString(),
    };

    internal static string? Day(object? v) => v switch
    {
        null or DBNull => null,
        DateTime d => DateOnly.FromDateTime(d).ToString("yyyy-MM-dd", CultureInfo.InvariantCulture),
        DateTimeOffset d => DateOnly.FromDateTime(d.DateTime).ToString("yyyy-MM-dd", CultureInfo.InvariantCulture),
        DateOnly d => d.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture),
        string s when DateOnly.TryParse(s.Length >= 10 ? s[..10] : s, CultureInfo.InvariantCulture, out var d)
            => d.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture),
        _ => throw new FormatException("date column of an unexpected type"),
    };

    /// <summary>OPERA keeps the expected arrival time as a date-time or as text (HH:mm or HHmm).</summary>
    internal static string? Clock(object? v)
    {
        switch (v)
        {
            case null or DBNull:
                return null;
            case DateTime d:
                return d.ToString("HH:mm", CultureInfo.InvariantCulture);
            case string s:
                var t = s.Trim().Replace(":", "", StringComparison.Ordinal);
                if (t.Length == 0) return null;
                if (t.Length == 4 && int.TryParse(t, NumberStyles.None, CultureInfo.InvariantCulture, out var hhmm)
                    && hhmm / 100 < 24 && hhmm % 100 < 60)
                    return $"{t[..2]}:{t[2..]}";
                return null;
            default:
                return null;
        }
    }

    internal static int Count(object? v, int fallback) => v switch
    {
        null or DBNull => fallback,
        int i => i,
        long l => (int)l,
        decimal m => (int)m,
        double d => (int)d,
        string s when int.TryParse(s, NumberStyles.Integer, CultureInfo.InvariantCulture, out var i) => i,
        _ => fallback,
    };
}
