using System.Globalization;
using System.Text.Json.Nodes;
using System.Xml.Linq;

namespace Hotella.Agent.Ows;

/// <summary>A reservation as polled, already in the JSON shape the platform's OWS parser reads (<c>reservation</c>).</summary>
public sealed record OwsReservation(string ReservationId, string Status, string? UpdatedAt, JsonObject Reservation);

/// <summary>OWS refused the call (SOAP fault or unsuccessful result); the message never holds credentials.</summary>
public sealed class OwsFaultException(string message) : Exception(message);

/// <summary>
/// The OWS 5.1 calls the agent makes, as XML (ADR-0014): <c>Reservation.FutureBookingSummary</c> for an arrival window,
/// with the OGHeader credentials. Elements are matched by local name so namespace prefixes and versions of the hotel's
/// OWS do not matter; the exact WSDL is verified at the pilot (BUILD_PLAN 10.3 notes).
/// </summary>
public static class OwsSoap
{
    public const string ReservationService = "Reservation.asmx";
    public const string FutureBookingSummaryAction = "http://webservices.micros.com/ows/5.1/Reservation.wsdl#FutureBookingSummary";
    private static readonly XNamespace Soap = "http://schemas.xmlsoap.org/soap/envelope/";
    private static readonly XNamespace Core = "http://webservices.micros.com/og/4.3/Core/";
    private static readonly XNamespace Res = "http://webservices.micros.com/ows/5.1/Reservation.wsdl";
    private static readonly XNamespace Hc = "http://webservices.micros.com/og/4.3/HotelCommon/";

    public static string FutureBookingSummaryRequest(OwsSettings s, string password, DateOnly from, DateOnly to, DateTimeOffset now)
    {
        ArgumentNullException.ThrowIfNull(s);
        var header = new XElement(Core + "OGHeader",
            new XAttribute("transactionID", now.ToUnixTimeMilliseconds().ToString(CultureInfo.InvariantCulture)),
            new XAttribute("timeStamp", now.ToString("yyyy-MM-ddTHH:mm:ss.fffzzz", CultureInfo.InvariantCulture)),
            new XElement(Core + "Origin", new XAttribute("entityID", s.OriginEntity), new XAttribute("systemType", "WEB")),
            new XElement(Core + "Destination", new XAttribute("entityID", s.DestinationEntity), new XAttribute("systemType", "PMS")),
            new XElement(Core + "Authentication",
                new XElement(Core + "UserCredentials",
                    new XElement(Core + "UserName", s.Username),
                    new XElement(Core + "UserPassword", password),
                    new XElement(Core + "Domain", s.Domain))));
        var body = new XElement(Res + "FutureBookingSummaryRequest",
            new XElement(Res + "AdditionalFilters",
                new XElement(Res + "HotelReference",
                    new XAttribute("chainCode", s.ChainCode), new XAttribute("hotelCode", s.HotelCode)),
                new XElement(Res + "ArrivalDateRange",
                    new XElement(Hc + "StartDate", from.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture)),
                    new XElement(Hc + "EndDate", to.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture)))));
        return new XDocument(new XDeclaration("1.0", "utf-8", null),
            new XElement(Soap + "Envelope", new XElement(Soap + "Header", header), new XElement(Soap + "Body", body)))
            .ToString(SaveOptions.DisableFormatting);
    }

    public static IReadOnlyList<OwsReservation> ParseFutureBookingSummary(string response)
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
        return [.. All(doc.Root, "HotelReservation").Select(Reservation).OfType<OwsReservation>()];
    }

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
