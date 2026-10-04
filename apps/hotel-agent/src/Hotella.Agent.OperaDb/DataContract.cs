using System.Globalization;

namespace Hotella.Agent.OperaDb;

/// <summary>
/// One predefined statement of the data contract. Instances exist only as the static members of
/// <see cref="DataContract"/>: there is no way to hand the data source any other SQL (guide §6.4 rule 1).
/// </summary>
public sealed class ContractStatement
{
    private ContractStatement(string id, string template, IReadOnlyList<string> binds)
    {
        Id = id;
        Template = template;
        Binds = binds;
    }

    public string Id { get; }

    /// <summary>The SQL with <c>{owner}</c> in place of the OPERA schema owner (validated identifier).</summary>
    public string Template { get; }

    /// <summary>The bind variables the statement takes, besides <c>:resort</c> and <c>:max_rows</c>.</summary>
    public IReadOnlyList<string> Binds { get; }

    public string Sql(string owner)
    {
        if (!OperaDbSettings.IsIdentifier(owner)) throw new InvalidOperationException("invalid schema owner");
        return Template.Replace("{owner}", owner, StringComparison.Ordinal);
    }

    internal static ContractStatement Define(string id, string template, params string[] binds) => new(id, template, binds);
}

/// <summary>
/// OPERA database data contract v1 (guide §6.3): the logical entities Hotella needs, mapped to OPERA 5.6 objects. Only
/// SELECTs, always filtered by the resort, with bind variables and a row cap; personal data limited to the contract
/// (no documents, cards, folios, amounts). Column names marked "to verify" in the guide are checked by the probe before
/// go-live (<c>hotella-agent opera-db probe</c>); a different schema is a new contract version, never an edit in place.
/// </summary>
public static class DataContract
{
    public const int Version = 1;

    /// <summary>Objects the account needs SELECT on — and nothing else (guide §6.2).</summary>
    public static readonly IReadOnlyList<string> Objects =
    [
        "RESORT",
        "RESERVATION_NAME",
        "RESERVATION_DAILY_ELEMENT_NAME",
        "RESERVATION_DAILY_ELEMENTS",
        "NAME",
        "NAME_PHONE",
        "ROOM",
        "ROOM_CATEGORY_TEMPLATE",
    ];

    /// <summary>OPERA reservation statuses the contract knows, and their canonical meaning.</summary>
    public static readonly IReadOnlyDictionary<string, string> Statuses = new Dictionary<string, string>(StringComparer.Ordinal)
    {
        ["RESERVED"] = "RESERVED",
        ["DUE IN"] = "RESERVED",
        ["CHECKED IN"] = "IN_HOUSE",
        ["DUE OUT"] = "IN_HOUSE",
        ["CHECKED OUT"] = "CHECKED_OUT",
        ["CANCELLED"] = "CANCELLED",
        ["NO SHOW"] = "NO_SHOW",
    };

    private const string KnownStatuses = "'RESERVED','DUE IN','CHECKED IN','DUE OUT','CHECKED OUT','CANCELLED','NO SHOW'";

    // The reservation's room, rate and persons on the night that matters: today while in house, else its first night.
    private const string ReservationColumns = """
        SELECT rn.RESV_NAME_ID AS RESV_NAME_ID, rn.CONFIRMATION_NO AS CONFIRMATION_NO, rn.RESV_STATUS AS RESV_STATUS,
               rn.TRUNC_BEGIN_DATE AS ARRIVAL_DATE, rn.TRUNC_END_DATE AS DEPARTURE_DATE,
               rn.ARRIVAL_ESTIMATE_TIME AS ETA, rden.ADULTS AS ADULTS, rden.CHILDREN AS CHILDREN,
               rde.ROOM AS ROOM, rde.ROOM_CATEGORY AS ROOM_CATEGORY, rden.RATE_CODE AS RATE_CODE,
               rde.MARKET_CODE AS MARKET_CODE, rn.NAME_ID AS NAME_ID, rn.PARENT_RESV_NAME_ID AS SHARE_OF
        FROM {owner}.RESERVATION_NAME rn
        LEFT JOIN {owner}.RESERVATION_DAILY_ELEMENT_NAME rden
          ON rden.RESORT = rn.RESORT AND rden.RESV_NAME_ID = rn.RESV_NAME_ID
         AND rden.RESERVATION_DATE = GREATEST(rn.TRUNC_BEGIN_DATE, LEAST(TRUNC(SYSDATE), rn.TRUNC_END_DATE - 1))
        LEFT JOIN {owner}.RESERVATION_DAILY_ELEMENTS rde
          ON rde.RESORT = rden.RESORT AND rde.RESV_DAILY_EL_SEQ = rden.RESV_DAILY_EL_SEQ
        """;

    public static readonly ContractStatement ReservationById = ContractStatement.Define("RESERVATION_BY_ID",
        ReservationColumns + $"""
         WHERE rn.RESORT = :resort AND rn.RESV_NAME_ID = :reservation_id AND rn.RESV_STATUS IN ({KnownStatuses})
         FETCH FIRST :max_rows ROWS ONLY
        """, "reservation_id");

    public static readonly ContractStatement ReservationByConfirmation = ContractStatement.Define("RESERVATION_BY_CONFIRMATION",
        ReservationColumns + $"""
         WHERE rn.RESORT = :resort AND rn.CONFIRMATION_NO = :confirmation_number AND rn.RESV_STATUS IN ({KnownStatuses})
         FETCH FIRST :max_rows ROWS ONLY
        """, "confirmation_number");

    public static readonly ContractStatement Arrivals = ContractStatement.Define("ARRIVALS",
        ReservationColumns + """
         WHERE rn.RESORT = :resort AND rn.TRUNC_BEGIN_DATE BETWEEN :from_date AND :to_date
           AND rn.RESV_STATUS IN ('RESERVED','DUE IN','CHECKED IN')
         ORDER BY rn.TRUNC_BEGIN_DATE, rn.RESV_NAME_ID
         FETCH FIRST :max_rows ROWS ONLY
        """, "from_date", "to_date");

    public static readonly ContractStatement InHouse = ContractStatement.Define("IN_HOUSE",
        ReservationColumns + """
         WHERE rn.RESORT = :resort AND rn.RESV_STATUS IN ('CHECKED IN','DUE OUT')
         ORDER BY rn.RESV_NAME_ID
         FETCH FIRST :max_rows ROWS ONLY
        """);

    public static readonly ContractStatement Profile = ContractStatement.Define("PROFILE", """
        SELECT n.NAME_ID AS NAME_ID, n.TITLE AS TITLE, n.FIRST AS FIRST, n.LAST AS LAST, n.LANGUAGE AS LANGUAGE,
               n.VIP_STATUS AS VIP_STATUS,
               (SELECT p.PHONE_NUMBER FROM {owner}.NAME_PHONE p
                 WHERE p.NAME_ID = n.NAME_ID AND p.PHONE_ROLE = 'EMAIL' ORDER BY p.PRIMARY_YN DESC FETCH FIRST 1 ROWS ONLY) AS EMAIL,
               (SELECT p.PHONE_NUMBER FROM {owner}.NAME_PHONE p
                 WHERE p.NAME_ID = n.NAME_ID AND p.PHONE_ROLE = 'PHONE' ORDER BY p.PRIMARY_YN DESC FETCH FIRST 1 ROWS ONLY) AS PHONE
        FROM {owner}.NAME n
        WHERE n.NAME_ID = :name_id
          AND EXISTS (SELECT 1 FROM {owner}.RESERVATION_NAME rn WHERE rn.RESORT = :resort AND rn.NAME_ID = n.NAME_ID)
        FETCH FIRST :max_rows ROWS ONLY
        """, "name_id");

    public static readonly ContractStatement Rooms = ContractStatement.Define("ROOMS", """
        SELECT r.ROOM AS ROOM, r.ROOM_CATEGORY AS ROOM_CATEGORY, r.FLOOR AS FLOOR
        FROM {owner}.ROOM r
        WHERE r.RESORT = :resort
        ORDER BY r.ROOM
        FETCH FIRST :max_rows ROWS ONLY
        """);

    /// <summary>The arrival window with the primary guest, for fallback change polling (guide §6.5).</summary>
    public static readonly ContractStatement ArrivalsWithGuest = ContractStatement.Define("ARRIVALS_WITH_GUEST", """
        SELECT x.*, n.TITLE AS TITLE, n.FIRST AS FIRST, n.LAST AS LAST, n.LANGUAGE AS LANGUAGE, n.VIP_STATUS AS VIP_STATUS
        FROM (
        """ + ReservationColumns + """
         WHERE rn.RESORT = :resort AND rn.TRUNC_BEGIN_DATE BETWEEN :from_date AND :to_date
           AND rn.RESV_STATUS IN ('RESERVED','DUE IN','CHECKED IN','CANCELLED','NO SHOW')
        ) x
        LEFT JOIN {owner}.NAME n ON n.NAME_ID = x.NAME_ID
        ORDER BY x.ARRIVAL_DATE, x.RESV_NAME_ID
        FETCH FIRST :max_rows ROWS ONLY
        """, "from_date", "to_date");

    /// <summary>Every statement the agent can run against OPERA (the allow-list).</summary>
    public static readonly IReadOnlyList<ContractStatement> All =
        [ReservationById, ReservationByConfirmation, Arrivals, InHouse, Profile, Rooms, ArrivalsWithGuest];

    /// <summary>The account's own privileges, for the self-check (guide §6.4 rule 3).</summary>
    public const string SystemPrivileges = "SELECT PRIVILEGE FROM USER_SYS_PRIVS";
    public const string TablePrivileges = "SELECT OWNER, TABLE_NAME, PRIVILEGE FROM USER_TAB_PRIVS WHERE GRANTEE = USER";
    public const string Roles = "SELECT GRANTED_ROLE FROM USER_ROLE_PRIVS";

    public static string Date(DateOnly d) => d.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture);
}
