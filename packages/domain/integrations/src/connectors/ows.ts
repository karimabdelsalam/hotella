import { z } from 'zod';
import type { InboundRecordInput } from '@hotella/contracts-connectors';

/**
 * OWS query results as the hotel agent forwards them after polling OPERA Web Services (ADR-0014), shared by
 * `OPERA5_OWS` and the simulator's OWS-shaped face: future reservations, profile details and ETA. The agent turns the
 * SOAP response into this JSON (one message per reservation that changed); field names follow OWS naming.
 */

const owsProfile = z.object({
  profileId: z.string().min(1).max(128).optional(),
  firstName: z.string().min(1).max(200),
  lastName: z.string().max(200).optional(),
  title: z.string().max(40).optional(),
  language: z.string().max(16).optional(),
  vipCode: z.string().max(64).optional(),
  email: z.string().max(320).optional(),
  phone: z.string().max(32).optional(),
  membershipNumber: z.string().max(64).optional(),
});

export const owsReservationSchema = z.object({
  action: z.enum(['NEW', 'CHANGE', 'CANCEL', 'NOSHOW']),
  modifiedAt: z.iso.datetime({ offset: true }),
  reservation: z.object({
    reservationId: z.string().min(1).max(128),
    confirmationNo: z.string().min(1).max(64).optional(),
    arrivalDate: z.iso.date().optional(),
    departureDate: z.iso.date().optional(),
    expectedArrivalTime: z.iso.datetime({ offset: true }).optional(),
    adults: z.number().int().min(0).max(50).optional(),
    children: z.number().int().min(0).max(50).optional(),
    roomNumber: z.string().max(64).optional(),
    ratePlanCode: z.string().max(64).optional(),
    marketCode: z.string().max(64).optional(),
    guest: owsProfile.optional(),
    sharers: z.array(owsProfile).max(20).optional(),
  }),
});

export const owsProfileMessageSchema = z.object({
  modifiedAt: z.iso.datetime({ offset: true }),
  reservationId: z.string().min(1).max(128).optional(),
  profile: owsProfile,
});

function toProfile(p: z.infer<typeof owsProfile>) {
  const lang = p.language?.trim().toLowerCase().slice(0, 2);
  return {
    external_id: p.profileId ?? null,
    given_name: p.firstName,
    family_name: p.lastName ?? null,
    title: p.title ?? null,
    locale: lang && /^[a-z]{2}$/.test(lang) ? lang : null,
    vip_code: p.vipCode ?? null,
    email: p.email ?? null,
    phone: p.phone ?? null,
    loyalty_number: p.membershipNumber ?? null,
  };
}

export function parseOwsReservation(payload: unknown): InboundRecordInput[] {
  const m = owsReservationSchema.parse(payload);
  const r = m.reservation;
  const reservation = {
    external_id: r.reservationId,
    confirmation_number: r.confirmationNo ?? null,
  };
  if (m.action === 'CANCEL' || m.action === 'NOSHOW') {
    return [
      {
        kind: 'RESERVATION_CANCELLED',
        reservation,
        outcome: m.action === 'CANCEL' ? 'CANCELLED' : 'NO_SHOW',
        occurred_at: m.modifiedAt,
      },
    ];
  }
  if (!r.guest || !r.arrivalDate || !r.departureDate)
    throw new Error('NEW/CHANGE reservations need guest, arrivalDate and departureDate');
  return [
    {
      kind: 'RESERVATION_UPSERT',
      change: m.action === 'NEW' ? 'CREATED' : 'UPDATED',
      reservation,
      primary_guest: toProfile(r.guest),
      accompanying_guests: (r.sharers ?? []).map(toProfile),
      arrival_date: r.arrivalDate,
      departure_date: r.departureDate,
      eta: r.expectedArrivalTime ?? null,
      adults: r.adults ?? 1,
      children: r.children ?? 0,
      room_code: r.roomNumber ?? null,
      rate_code: r.ratePlanCode ?? null,
      market_code: r.marketCode ?? null,
      occurred_at: m.modifiedAt,
    },
  ];
}

export function parseOwsProfile(payload: unknown): InboundRecordInput[] {
  const m = owsProfileMessageSchema.parse(payload);
  return [
    {
      kind: 'PROFILE_UPDATE',
      reservation: m.reservationId ? { external_id: m.reservationId } : null,
      profile: toProfile(m.profile),
      occurred_at: m.modifiedAt,
    },
  ];
}
