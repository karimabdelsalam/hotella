using System.Globalization;
using System.Text.Json.Nodes;
using System.Xml.Linq;

namespace Hotella.Agent.Ows;

/// <summary>A reservation as polled, already in the JSON shape the platform's OWS parser reads (<c>reservation</c>).</summary>
public sealed record OwsReservation(string ReservationId, string Status, string? UpdatedAt, JsonObject Reservation);

/// <summary>A profile as read from OWS (<c>profile</c> in the platform's shape), with all its e-mails and phones.</summary>
public sealed record OwsProfile(JsonObject Profile, IReadOnlyList<string> Emails, IReadOnlyList<string> Phones);

/// <summary>OWS refused the call (SOAP fault or unsuccessful result); the message never holds credentials.</summary>
public sealed class OwsFaultException(string message) : Exception(message);

/// <summary>
/// The OWS 5.1 calls of the standard OWS connector v1 (ADR-0019; guide §8), as XML: <c>Reservation.FutureBookingSummary</c>
/// (arrival window) and <c>FetchBooking</c>, <c>Name.FetchProfile</c>, and the additive contact writes
/// <c>Name.InsertEmail</c> / <c>InsertPhone</c>, each with the OGHeader credentials. Elements are matched by local name so namespace prefixes and versions of the hotel's
/// OWS do not matter; the exact WSDL is verified at the pilot (BUILD_PLAN 10.3 notes).
/// </summary>
public static class OwsSoap
{
    public const string ReservationService = "Reservation.asmx";
    public const string NameService = "Name.asmx";
    public const string FutureBookingSummaryAction = "http://webservices.micros.com/ows/5.1/Reservation.wsdl#FutureBookingSummary";
    public const string FetchBookingAction = "http://webservices.micros.com/ows/5.1/Reservation.wsdl#FetchBooking";
    public const string FetchProfileAction = "http://webservices.micros.com/ows/5.1/Name.wsdl#FetchProfile";
    public const string InsertEmailAction = "http://webservices.micros.com/ows/5.1/Name.wsdl#InsertEmail";
    public const string InsertPhoneAction = "http://webservices.micros.com/ows/5.1/Name.wsdl#InsertPhone";
    private static readonly XNamespace Soap = "http://schemas.xmlsoap.org/soap/envelope/";
    private static readonly XNamespace Core = "http://webservices.micros.com/og/4.3/Core/";
    private static readonly XNamespace Res = "http://webservices.micros.com/ows/5.1/Reservation.wsdl";
    private static readonly XNamespace Hc = "http://webservices.micros.com/og/4.3/HotelCommon/";
    private static readonly XNamespace NameWsdl = "http://webservices.micros.com/ows/5.1/Name.wsdl";
    private static readonly XNamespace NameTypes = "http://webservices.micros.com/og/4.3/Name/";

    /// <summary>The OGHeader every request carries (guide §8.2): transaction, origin/destination entities, credentials.</summary>
    private static XElement Header(OwsSettings s, string password, DateTimeOffset now) =>
        new(Core + "OGHeader",
            new XAttribute("transactionID", now.ToUnixTimeMilliseconds().ToString(CultureInfo.InvariantCulture)),
            new XAttribute("timeStamp", now.ToString("yyyy-MM-ddTHH:mm:ss.fffzzz", CultureInfo.InvariantCulture)),
            new XElement(Core + "Origin", new XAttribute("entityID", s.OriginEntity), new XAttribute("systemType", "WEB")),
            new XElement(Core + "Destination", new XAttribute("entityID", s.DestinationEntity), new XAttribute("systemType", "PMS")),
            new XElement(Core + "Authentication",
                new XElement(Core + "UserCredentials",
                    new XElement(Core + "UserName", s.Username),
                    new XElement(Core + "UserPassword", password),
                    new XElement(Core + "Domain", s.Domain))));

    private static string Envelope(OwsSettings s, string password, DateTimeOffset now, XElement body) =>
        new XDocument(new XDeclaration("1.0", "utf-8", null),
            new XElement(Soap + "Envelope", new XElement(Soap + "Header", Header(s, password, now)), new XElement(Soap + "Body", body)))
            .ToString(SaveOptions.DisableFormatting);

    private static XElement HotelReference(XNamespace ns, OwsSettings s) =>
        new(ns + "HotelReference", new XAttribute("chainCode", s.ChainCode), new XAttribute("hotelCode", s.HotelCode));

    public static string FutureBookingSummaryRequest(OwsSettings s, string password, DateOnly from, DateOnly to, DateTimeOffset now)
    {
        ArgumentNullException.ThrowIfNull(s);
        return Envelope(s, password, now, new XElement(Res + "FutureBookingSummaryRequest",
            new XElement(Res + "AdditionalFilters",
                HotelReference(Res, s),
                new XElement(Res + "ArrivalDateRange",
                    new XElement(Hc + "StartDate", from.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture)),
                    new XElement(Hc + "EndDate", to.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture))))));
    }

    /// <summary><c>Reservation.FetchBooking</c> by confirmation number or by OPERA reservation id (RESV_NAME_ID).</summary>
    public static string FetchBookingRequest(
        OwsSettings s, string password, string? confirmationNumber, string? reservationId, DateTimeOffset now)
    {
        ArgumentNullException.ThrowIfNull(s);
        var key = reservationId is not null
            ? new XElement(Res + "ResvNameId", new XAttribute("type", "INTERNAL"), new XAttribute("source", "RESV_NAME_ID"), reservationId)
            : new XElement(Res + "ConfirmationNumber", new XAttribute("type", "INTERNAL"),
                confirmationNumber ?? throw new ArgumentException("a confirmation number or reservation id is required"));
        return Envelope(s, password, now, new XElement(Res + "FetchBookingRequest", HotelReference(Res, s), key));
    }

    /// <summary><c>Name.FetchProfile</c> by OPERA profile id (NAME_ID).</summary>
    public static string FetchProfileRequest(OwsSettings s, string password, string profileId, DateTimeOffset now)
    {
        ArgumentNullException.ThrowIfNull(s);
        return Envelope(s, password, now, new XElement(NameWsdl + "FetchProfileRequest",
            new XElement(NameWsdl + "NameID", new XAttribute("type", "INTERNAL"), profileId)));
    }

    /// <summary><c>Name.InsertEmail</c>: adds an e-mail as the primary one; never replaces or deletes the existing ones.</summary>
    public static string InsertEmailRequest(OwsSettings s, string password, string profileId, string email, DateTimeOffset now)
    {
        ArgumentNullException.ThrowIfNull(s);
        return Envelope(s, password, now, new XElement(NameWsdl + "InsertEmailRequest",
            new XElement(NameWsdl + "NameID", new XAttribute("type", "INTERNAL"), profileId),
            new XElement(NameWsdl + "NameEmail", new XAttribute("primary", "true"), new XAttribute("emailType", "EMAIL"), email)));
    }

    /// <summary><c>Name.InsertPhone</c>: adds a mobile number as the primary one; never replaces the existing ones.</summary>
    public static string InsertPhoneRequest(OwsSettings s, string password, string profileId, string phone, DateTimeOffset now)
    {
        ArgumentNullException.ThrowIfNull(s);
        return Envelope(s, password, now, new XElement(NameWsdl + "InsertPhoneRequest",
            new XElement(NameWsdl + "NameID", new XAttribute("type", "INTERNAL"), profileId),
            new XElement(NameWsdl + "NamePhone", new XAttribute("phoneType", "MOBILE"), new XAttribute("phoneRole", "PHONE"),
                new XAttribute("primary", "true"), new XElement(NameTypes + "PhoneNumber", phone))));
    }

    /// <summary>The response document after its SOAP fault and result flag were checked (reasons only, never data).</summary>
    public static XDocument Checked(string response)
    {
        XDocument doc;
        try
        {
            doc = XDocument.Parse(response);
        }
        catch (System.Xml.XmlException e)
        {
            throw new OwsFaultException($"OWS answered with unreadable XML ({e.Message})");
        }
        if (First(doc.Root, "Fault") is { } fault)
            throw new OwsFaultException("OWS fault: " + (Text(fault, "faultstring") ?? "unknown"));
        var result = First(doc.Root, "Result");
        if (result?.Attribute("resultStatusFlag")?.Value is { } flag && flag != "SUCCESS")
            throw new OwsFaultException($"OWS result {flag}: " + (Text(result, "Text") ?? ""));
        return doc;
    }

    public static OwsReservation? ParseFetchBooking(string response) =>
        All(Checked(response).Root, "HotelReservation").Select(Reservation).OfType<OwsReservation>().FirstOrDefault();

    /// <summary>The profile of a FetchProfile answer (null when OWS has none), with every e-mail and phone it holds.</summary>
    public static OwsProfile? ParseFetchProfile(string response, string profileId)
    {
        var root = Checked(response).Root;
        var details = First(root, "ProfileDetails") ?? First(root, "Profile");
        if (details is null) return null;
        var json = Profile(details) ?? new JsonObject();
        json["profileId"] = profileId;
        return new OwsProfile(json,
            [.. All(details, "NameEmail").Select(e => e.Value.Trim()).Where(v => v.Length > 0)],
            [.. All(details, "PhoneNumber").Select(e => e.Value.Trim()).Where(v => v.Length > 0)]);
    }

    public static IReadOnlyList<OwsReservation> ParseFutureBookingSummary(string response) =>
        [.. All(Checked(response).Root, "HotelReservation").Select(Reservation).OfType<OwsReservation>()];

    private static OwsReservation? Reservation(XElement r)
    {
        var ids = All(r, "UniqueIDList").SelectMany(l => All(l, "UniqueID")).ToList();
        var reservationId = ids.FirstOrDefault(i => i.Attribute("source")?.Value == "RESV_NAME_ID")?.Value
            ?? ids.FirstOrDefault()?.Value;
        if (string.IsNullOrWhiteSpace(reservationId)) return null;
        var confirmation = ids.FirstOrDefault(i => i.Attribute("source") is null && i.Value != reservationId)?.Value;
        var stay = First(r, "RoomStay");
        var json = new JsonObject { ["reservationId"] = reservationId };
        if (confirmation is not null) json["confirmationNo"] = confirmation;
        if (stay is not null)
        {
            if (Text(First(stay, "TimeSpan"), "StartDate") is { Length: >= 10 } arrival) json["arrivalDate"] = arrival[..10];
            if (Text(First(stay, "TimeSpan"), "EndDate") is { Length: >= 10 } departure) json["departureDate"] = departure[..10];
            if (Text(stay, "ExpectedArrivalTime") is { } eta) json["expectedArrivalTime"] = eta;
            foreach (var count in All(stay, "GuestCount"))
            {
                var n = int.TryParse(count.Attribute("count")?.Value, CultureInfo.InvariantCulture, out var v) ? v : 0;
                if (count.Attribute("ageQualifyingCode")?.Value == "ADULT") json["adults"] = n;
                else if (count.Attribute("ageQualifyingCode")?.Value == "CHILD") json["children"] = n;
            }
            if (Text(stay, "RoomNumber") is { } room) json["roomNumber"] = room;
            if (First(stay, "RatePlan")?.Attribute("ratePlanCode")?.Value is { } rate) json["ratePlanCode"] = rate;
            if (Text(stay, "MarketSegment") is { } market) json["marketCode"] = market;
        }
        var guests = All(r, "ResGuest")
            .OrderBy(g => int.TryParse(g.Attribute("resGuestRPH")?.Value, CultureInfo.InvariantCulture, out var n) ? n : 99)
            .Select(g => First(g, "Profile")).OfType<XElement>().Select(Profile).OfType<JsonObject>().ToList();
        if (guests.Count > 0)
        {
            json["guest"] = guests[0];
            if (guests.Count > 1) json["sharers"] = new JsonArray([.. guests.Skip(1)]);
        }
        var status = r.Attribute("reservationStatus")?.Value?.ToUpperInvariant() ?? "RESERVED";
        var updated = First(r, "ReservationHistory")?.Attribute("updateDate")?.Value;
        return new OwsReservation(reservationId, status, updated, json);
    }

    private static JsonObject? Profile(XElement p)
    {
        var first = Text(p, "firstName");
        if (string.IsNullOrWhiteSpace(first)) return null;
        var json = new JsonObject { ["firstName"] = first };
        if (Text(p, "lastName") is { } last) json["lastName"] = last;
        if (Text(p, "nameTitle") is { } title) json["title"] = title;
        if (p.Attribute("languageCode")?.Value is { Length: > 0 } language) json["language"] = language;
        if (p.Attribute("vipCode")?.Value is { Length: > 0 } vip) json["vipCode"] = vip;
        if (All(p, "UniqueID").FirstOrDefault(i => i.Attribute("source")?.Value == "NAME_ID")?.Value is { } id)
            json["profileId"] = id;
        if (Text(p, "NameEmail") is { } email) json["email"] = email;
        if (Text(p, "PhoneNumber") is { } phone) json["phone"] = phone;
        return json;
    }

    private static IEnumerable<XElement> All(XElement? scope, string localName) =>
        scope?.Descendants().Where(e => e.Name.LocalName == localName) ?? [];

    private static XElement? First(XElement? scope, string localName) => All(scope, localName).FirstOrDefault();

    private static string? Text(XElement? scope, string localName) =>
        First(scope, localName)?.Value is { Length: > 0 } v ? v.Trim() : null;
}
