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
 * The simulator's OPERA Web Services face (BUILD_PLAN §10 Phase 10, Sprint 10.3): an HTTP SOAP endpoint answering
 * `Reservation.FutureBookingSummary` for an arrival window from the simulated PMS's current reservations, in the OWS
 * 5.1 shapes the agent reads (HotelReservation with UniqueIDList, RoomStay, ResGuests/Profiles, reservationStatus).
 * The OGHeader's user and password must match; anything else is a SOAP fault, as OWS answers.
 */
export class OwsSoapFace {
  private server: Server | null = null;
  /** Requests served (and refused), for assertions. */
  readonly stats = { requests: 0, refused: 0 };

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
          if (req.method !== 'POST' || !req.url?.endsWith('/Reservation.asmx'))
            return fault('unknown service');
          if (
            text(body, 'UserName') !== this.credentials.user ||
            text(body, 'UserPassword') !== this.credentials.password
          )
            return fault('Invalid user credentials');
          if (!/<(?:[\w-]+:)?FutureBookingSummaryRequest\b/.test(body))
            return fault('unsupported operation');
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
