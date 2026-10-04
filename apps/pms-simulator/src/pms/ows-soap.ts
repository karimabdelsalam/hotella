import { createServer, type Server } from 'node:http';
import type { SimGuest, SimReservation, SimulatedPms } from './hotel';

const STATUS: Record<SimReservation['status'], string> = {
  RESERVED: 'RESERVED',
  IN_HOUSE: 'CHECKEDIN',
  CHECKED_OUT: 'CHECKEDOUT',
  CANCELLED: 'CANCELED',
  NO_SHOW: 'NOSHOW',
};

const xml = (value: string): string =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** The text of the first element with this local name (namespace prefixes ignored). */
const text = (body: string, name: string): string | undefined =>
  new RegExp(`<(?:[\\w-]+:)?${name}\\b[^>]*>([^<]*)</(?:[\\w-]+:)?${name}>`).exec(body)?.[1];

function profileDetails(
  tag: string,
  g: SimGuest,
  contacts: { emails: string[]; phones: string[] },
): string {
  return `<${tag}${g.language ? ` languageCode="${xml(g.language.toUpperCase())}"` : ''}${g.vip ? ` vipCode="${xml(g.vip)}"` : ''}><Customer><PersonName>${g.title ? `<nameTitle>${xml(g.title)}</nameTitle>` : ''}<firstName>${xml(g.first)}</firstName>${
    g.last ? `<lastName>${xml(g.last)}</lastName>` : ''
  }</PersonName></Customer><Phones>${contacts.phones
    .map(
      (p, i) => `<NamePhone primary="${i === 0}"><PhoneNumber>${xml(p)}</PhoneNumber></NamePhone>`,
    )
    .join('')}</Phones><EMails>${contacts.emails
    .map((e, i) => `<NameEmail primary="${i === 0}">${xml(e)}</NameEmail>`)
    .join('')}</EMails></${tag}>`;
}

function profile(g: SimGuest, rph: number): string {
  return `<ResGuest resGuestRPH="${rph}"><Profiles><Profile${g.language ? ` languageCode="${xml(g.language.toUpperCase())}"` : ''}${g.vip ? ` vipCode="${xml(g.vip)}"` : ''}>${
    g.profileId
      ? `<ProfileIDs><UniqueID type="INTERNAL" source="NAME_ID">${xml(g.profileId)}</UniqueID></ProfileIDs>`
      : ''
  }<Customer><PersonName>${g.title ? `<nameTitle>${xml(g.title)}</nameTitle>` : ''}<firstName>${xml(g.first)}</firstName>${
    g.last ? `<lastName>${xml(g.last)}</lastName>` : ''
  }</PersonName></Customer>${g.email ? `<EMails><NameEmail primary="true">${xml(g.email)}</NameEmail></EMails>` : ''}${
    g.phone
      ? `<Phones><NamePhone primary="true"><PhoneNumber>${xml(g.phone)}</PhoneNumber></NamePhone></Phones>`
      : ''
  }</Profile></Profiles></ResGuest>`;
}

function reservation(r: SimReservation, updated: string): string {
  return `<HotelReservation reservationStatus="${STATUS[r.status]}"><UniqueIDList><UniqueID type="INTERNAL" source="RESV_NAME_ID">${xml(r.id)}</UniqueID><UniqueID type="INTERNAL">${xml(r.confirmation)}</UniqueID></UniqueIDList><RoomStays><RoomStay>${
    r.rate ? `<RatePlans><RatePlan ratePlanCode="${xml(r.rate)}"/></RatePlans>` : ''
  }${r.room ? `<RoomTypes><RoomType><RoomNumber>${xml(r.room)}</RoomNumber></RoomType></RoomTypes>` : ''}<GuestCounts><GuestCount ageQualifyingCode="ADULT" count="${r.adults}"/><GuestCount ageQualifyingCode="CHILD" count="${r.children}"/></GuestCounts><TimeSpan><StartDate>${r.arrival}</StartDate><EndDate>${r.departure}</EndDate></TimeSpan>${
    r.eta ? `<ExpectedArrivalTime>${xml(r.eta)}</ExpectedArrivalTime>` : ''
  }${r.market ? `<MarketSegment>${xml(r.market)}</MarketSegment>` : ''}</RoomStay></RoomStays><ResGuests>${[
    r.guest,
    ...r.sharers,
  ]
    .map((g, i) => profile(g, i))
    .join('')}</ResGuests><ReservationHistory updateDate="${updated}"/></HotelReservation>`;
}

const envelope = (body: string) =>
  `<?xml version="1.0" encoding="utf-8"?><soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body>${body}</soap:Body></soap:Envelope>`;

/**
 * The simulator's OPERA Web Services face (BUILD_PLAN §10 Phase 10, Sprints 10.3 and 10.8): an HTTP SOAP endpoint
 * answering the operations of the standard OWS connector v1 — `Reservation.FutureBookingSummary` (arrival window) and
 * `FetchBooking`, `Name.FetchProfile`, and the additive `Name.InsertEmail` / `InsertPhone` — from the simulated PMS, in the OWS
 * 5.1 shapes the agent reads (HotelReservation with UniqueIDList, RoomStay, ResGuests/Profiles, reservationStatus).
 * The OGHeader's user and password must match; anything else is a SOAP fault, as OWS answers.
 */
export class OwsSoapFace {
  private server: Server | null = null;
  /** Requests served (and refused), for assertions. */
  readonly stats = { requests: 0, refused: 0 };
  /** `Service.Operation` of every authenticated request, in order. */
  readonly operations: string[] = [];

  constructor(
    private readonly pms: SimulatedPms,
    private readonly credentials: { user: string; password: string },
  ) {}

  /** Listens on 127.0.0.1; resolves to the base URL (…/OWS/). */
  listen(port = 0): Promise<string> {
    return new Promise((resolve, reject) => {
      const server = createServer((req, res) => {
        let body = '';
        req.on('data', (c: Buffer) => (body += c.toString('utf8')));
        req.on('end', () => {
          this.stats.requests++;
          const send = (status: number, payload: string) => {
            res.writeHead(status, { 'content-type': 'text/xml; charset=utf-8' });
            res.end(payload);
          };
          const fault = (message: string) => {
            this.stats.refused++;
            send(
              500,
              envelope(
                `<soap:Fault><faultcode>soap:Client</faultcode><faultstring>${xml(message)}</faultstring></soap:Fault>`,
              ),
            );
          };
          const service = req.url?.endsWith('/Reservation.asmx')
            ? 'Reservation'
            : req.url?.endsWith('/Name.asmx')
              ? 'Name'
              : null;
          if (req.method !== 'POST' || !service) return fault('unknown service');
          if (
            text(body, 'UserName') !== this.credentials.user ||
            text(body, 'UserPassword') !== this.credentials.password
          )
            return fault('Invalid user credentials');
          const operation = /<(?:[\w-]+:)?(\w+)Request\b/.exec(
            body.slice(body.search(/<(?:[\w-]+:)?Body\b/)),
          )?.[1];
          this.operations.push(`${service}.${operation ?? '?'}`);
          const ok = (name: string, inner = '') =>
            send(
              200,
              envelope(
                `<${name}Response xmlns="http://webservices.micros.com/ows/5.1/${service}.wsdl"><Result resultStatusFlag="SUCCESS"/>${inner}</${name}Response>`,
              ),
            );
          if (service === 'Reservation' && operation === 'FetchBooking') {
            const byId = text(body, 'ResvNameId');
            const byConfirmation = text(body, 'ConfirmationNumber');
            const r = [...this.pms.reservations.values()].find((x) =>
              byId ? x.id === byId : x.confirmation === byConfirmation,
            );
            // No match: an empty answer (how a hotel's OWS words "not found" is checked at commissioning).
            if (!r) return ok('FetchBooking');
            return ok('FetchBooking', reservation(r, new Date().toISOString()));
          }
          if (service === 'Name') {
            const profileId = text(body, 'NameID') ?? '';
            const g = this.pms.profile(profileId);
            if (!g) return fault('Profile not found');
            if (operation === 'FetchProfile')
              return ok(
                'FetchProfile',
                profileDetails('ProfileDetails', g, this.pms.contacts(profileId)),
              );
            if (operation === 'InsertEmail' || operation === 'InsertPhone') {
              const value =
                operation === 'InsertEmail' ? text(body, 'NameEmail') : text(body, 'PhoneNumber');
              if (!value) return fault('missing value');
              this.pms.addContact(
                profileId,
                operation === 'InsertEmail' ? 'email' : 'phone',
                value,
              );
              return ok(operation);
            }
            return fault('unsupported operation');
          }
          if (operation !== 'FutureBookingSummary') return fault('unsupported operation');
          const start = text(body, 'StartDate') ?? '0000-01-01';
          const end = text(body, 'EndDate') ?? '9999-12-31';
          const updated = new Date().toISOString();
          const found = [...this.pms.reservations.values()].filter(
            (r) => r.arrival >= start && r.arrival <= end,
          );
          send(
            200,
            envelope(
              `<FutureBookingSummaryResponse xmlns="http://webservices.micros.com/ows/5.1/Reservation.wsdl"><Result resultStatusFlag="SUCCESS"/><HotelReservations>${found
                .map((r) => reservation(r, updated))
                .join('')}</HotelReservations></FutureBookingSummaryResponse>`,
            ),
          );
        });
      });
      server.once('error', reject);
      server.listen(port, '127.0.0.1', () => {
        this.server = server;
        const address = server.address();
        resolve(
          `http://127.0.0.1:${typeof address === 'object' && address ? address.port : port}/OWS/`,
        );
      });
    });
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve) =>
      this.server ? this.server.close(() => resolve()) : resolve(),
    );
  }
}
