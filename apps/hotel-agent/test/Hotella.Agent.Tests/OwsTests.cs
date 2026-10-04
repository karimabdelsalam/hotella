using System.Net;
using System.Text.Json.Nodes;
using Hotella.Agent.Core.Link;
using Hotella.Agent.Core.Queue;
using Hotella.Agent.Ows;
using Microsoft.Extensions.Logging.Abstractions;

namespace Hotella.Agent.Tests;

public class OwsTests
{
    private static readonly OwsSettings Settings = new()
    {
        Url = new Uri("http://127.0.0.1:9/OWS/"),
        Username = "HOTELLA",
        HotelCode = "CAIRO1",
        ChainCode = "CHA",
        Domain = "CAIRO1",
    };

    private static string Reservation(string id, string status, string departure = "2026-10-13", string? eta = null) => $"""
        <HotelReservation reservationStatus="{status}">
          <r:UniqueIDList xmlns:r="urn:any"><r:UniqueID type="INTERNAL" source="RESV_NAME_ID">{id}</r:UniqueID><r:UniqueID type="INTERNAL">C{id}</r:UniqueID></r:UniqueIDList>
          <RoomStays><RoomStay>
            <RatePlans><RatePlan ratePlanCode="BAR"/></RatePlans>
            <GuestCounts><GuestCount ageQualifyingCode="ADULT" count="2"/><GuestCount ageQualifyingCode="CHILD" count="1"/></GuestCounts>
            <TimeSpan><StartDate>2026-10-10</StartDate><EndDate>{departure}</EndDate></TimeSpan>
            {(eta is null ? "" : $"<ExpectedArrivalTime>{eta}</ExpectedArrivalTime>")}
          </RoomStay></RoomStays>
          <ResGuests>
            <ResGuest resGuestRPH="1"><Profiles><Profile><Customer><PersonName><firstName>Omar</firstName><lastName>Nile</lastName></PersonName></Customer></Profile></Profiles></ResGuest>
            <ResGuest resGuestRPH="0"><Profiles><Profile languageCode="AR" vipCode="V1"><ProfileIDs><UniqueID source="NAME_ID">P1</UniqueID></ProfileIDs>
              <Customer><PersonName><nameTitle>Mrs</nameTitle><firstName>Amira</firstName><lastName>Nile</lastName></PersonName></Customer>
              <EMails><NameEmail>amira@example.com</NameEmail></EMails></Profile></Profiles></ResGuest>
          </ResGuests>
          <ReservationHistory updateDate="2026-10-04T09:00:00Z"/>
        </HotelReservation>
        """;

    private static string Response(params string[] reservations) => $"""
        <?xml version="1.0" encoding="utf-8"?>
        <soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body>
        <FutureBookingSummaryResponse xmlns="http://webservices.micros.com/ows/5.1/Reservation.wsdl">
        <Result resultStatusFlag="SUCCESS"/><HotelReservations>{string.Concat(reservations)}</HotelReservations>
        </FutureBookingSummaryResponse></soap:Body></soap:Envelope>
        """;

    [Fact]
    public void The_request_names_the_hotel_window_and_credentials()
    {
        var xml = OwsSoap.FutureBookingSummaryRequest(Settings, "s3cret", new DateOnly(2026, 10, 3), new DateOnly(2026, 10, 18),
            new DateTimeOffset(2026, 10, 4, 9, 0, 0, TimeSpan.Zero));
        Assert.Contains("<UserName>HOTELLA</UserName>", xml, StringComparison.Ordinal);
        Assert.Contains("<UserPassword>s3cret</UserPassword>", xml, StringComparison.Ordinal);
        Assert.Contains("hotelCode=\"CAIRO1\"", xml, StringComparison.Ordinal);
        Assert.Contains("2026-10-03</", xml, StringComparison.Ordinal);
        Assert.Contains("2026-10-18</", xml, StringComparison.Ordinal);
        Assert.Contains("FutureBookingSummaryRequest", xml, StringComparison.Ordinal);
    }

    [Fact]
    public void Responses_are_read_by_local_name_into_the_platform_shape()
    {
        var r = Assert.Single(OwsSoap.ParseFutureBookingSummary(Response(Reservation("771234", "RESERVED", eta: "2026-10-10T14:30:00+03:00"))));
        Assert.Equal("771234", r.ReservationId);
        Assert.Equal("RESERVED", r.Status);
        var json = r.Reservation;
        Assert.Equal("C771234", json["confirmationNo"]!.GetValue<string>());
        Assert.Equal("2026-10-10", json["arrivalDate"]!.GetValue<string>());
        Assert.Equal(2, json["adults"]!.GetValue<int>());
        Assert.Equal(1, json["children"]!.GetValue<int>());
        Assert.Equal("2026-10-10T14:30:00+03:00", json["expectedArrivalTime"]!.GetValue<string>());
        // The primary guest is RPH 0 whatever the order in the document; the others are sharers.
        Assert.Equal("Amira", json["guest"]!["firstName"]!.GetValue<string>());
        Assert.Equal("P1", json["guest"]!["profileId"]!.GetValue<string>());
        Assert.Equal("AR", json["guest"]!["language"]!.GetValue<string>());
        Assert.Equal("Omar", json["sharers"]![0]!["firstName"]!.GetValue<string>());
    }

    [Fact]
    public void A_fault_names_the_reason_only()
    {
        var fault = """<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body><soap:Fault><faultcode>soap:Client</faultcode><faultstring>Invalid user credentials</faultstring></soap:Fault></soap:Body></soap:Envelope>""";
        var e = Assert.Throws<OwsFaultException>(() => OwsSoap.ParseFutureBookingSummary(fault));
        Assert.Equal("OWS fault: Invalid user credentials", e.Message);
        Assert.Throws<OwsFaultException>(() => OwsSoap.ParseFutureBookingSummary("not xml"));
    }

    [Fact]
    public async Task Only_changes_are_forwarded_new_change_cancel_once_each()
    {
        var ows = new FakeOws();
        using var adapter = new OwsAdapter(Settings, "instance-a", () => "s3cret", ":memory:", NullLogger.Instance, ows,
            () => new DateTimeOffset(2026, 10, 4, 9, 0, 0, TimeSpan.Zero));
        var link = new Collector();

        ows.Body = Response(Reservation("1", "RESERVED"), Reservation("2", "CANCELED"));
        Assert.Equal(1, await adapter.PollOnceAsync(link, CancellationToken.None)); // 2 was never live: nothing to cancel
        Assert.Equal(0, await adapter.PollOnceAsync(link, CancellationToken.None)); // nothing changed
        ows.Body = Response(Reservation("1", "RESERVED", departure: "2026-10-14"));
        Assert.Equal(1, await adapter.PollOnceAsync(link, CancellationToken.None));
        ows.Body = Response(Reservation("1", "CANCELED", departure: "2026-10-14"));
        Assert.Equal(1, await adapter.PollOnceAsync(link, CancellationToken.None));
        Assert.Equal(0, await adapter.PollOnceAsync(link, CancellationToken.None));

        Assert.Equal(["NEW", "CHANGE", "CANCEL"], link.Payloads.Select(p => p["action"]!.GetValue<string>()));
        Assert.Equal("2026-10-14", link.Payloads[1]["reservation"]!["departureDate"]!.GetValue<string>());
        Assert.Equal("2026-10-04T09:00:00.000Z", link.Payloads[0]["modifiedAt"]!.GetValue<string>());
        Assert.Equal(3, link.Ids.Distinct().Count());
        Assert.Contains("<UserPassword>s3cret</UserPassword>", ows.LastRequest, StringComparison.Ordinal);
        Assert.Equal("\"" + OwsSoap.FutureBookingSummaryAction + "\"", ows.LastSoapAction);
    }

    [Fact]
    public async Task Without_the_password_or_with_a_fault_the_poll_fails_and_forwards_nothing()
    {
        var ows = new FakeOws { Status = HttpStatusCode.InternalServerError, Body = """<Envelope><Body><Fault><faultstring>Invalid user credentials</faultstring></Fault></Body></Envelope>""" };
        var link = new Collector();
        using var noPassword = new OwsAdapter(Settings, "a", () => null, ":memory:", NullLogger.Instance, ows);
        await Assert.ThrowsAsync<OwsFaultException>(() => noPassword.PollOnceAsync(link, CancellationToken.None));
        using var refused = new OwsAdapter(Settings, "a", () => "wrong", ":memory:", NullLogger.Instance, ows);
        var e = await Assert.ThrowsAsync<OwsFaultException>(() => refused.PollOnceAsync(link, CancellationToken.None));
        Assert.DoesNotContain("wrong", e.Message, StringComparison.Ordinal);
        Assert.Empty(link.Payloads);
    }

    private sealed class FakeOws : HttpMessageHandler
    {
        public string Body { get; set; } = "";
        public HttpStatusCode Status { get; set; } = HttpStatusCode.OK;
        public string LastRequest { get; private set; } = "";
        public string? LastSoapAction { get; private set; }

        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            LastRequest = await request.Content!.ReadAsStringAsync(cancellationToken);
            LastSoapAction = request.Headers.GetValues("SOAPAction").Single();
            return new HttpResponseMessage(Status) { Content = new StringContent(Body) };
        }
    }

    private sealed class Collector : IMessagePublisher
    {
        public List<JsonObject> Payloads { get; } = [];
        public List<string> Ids { get; } = [];

        public QueuedMessage Publish(string sourceMessageId, string messageType, string? occurredAt, string payloadJson)
        {
            Assert.Equal("OWS_RESERVATION", messageType);
            Ids.Add(sourceMessageId);
            Payloads.Add(JsonNode.Parse(payloadJson)!.AsObject());
            return new QueuedMessage(Ids.Count, sourceMessageId, messageType, occurredAt, payloadJson);
        }
    }
}
