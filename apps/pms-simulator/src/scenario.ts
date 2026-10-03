import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { z } from 'zod';
import type { AgentLinkClient } from './agent/link-client';
import type { SimulatedPms } from './pms/hotel';

/**
 * Scripted scenarios (YAML) replayed in CI and by hand: PMS operations plus link chaos (duplicate, reorder, drop).
 * Assertions live in the test or the operator's eyes; a scenario only drives the PMS and the link.
 */

const guest = z.object({
  profileId: z.string().optional(),
  first: z.string(),
  last: z.string().optional(),
  title: z.string().optional(),
  language: z.string().optional(),
  vip: z.string().optional(),
  email: z.string().optional(),
  phone: z.string().optional(),
});
const date = z.iso.date();
const at = z.iso.datetime({ offset: true }).optional();

const step = z.union([
  z.object({
    reserve: z.object({
      id: z.string(),
      confirmation: z.string().optional(),
      guest,
      sharers: z.array(guest).optional(),
      arrival: date,
      departure: date,
      eta: z.iso.datetime({ offset: true }).optional(),
      adults: z.number().int().optional(),
      children: z.number().int().optional(),
      room: z.string().optional(),
      rate: z.string().optional(),
      market: z.string().optional(),
    }),
  }),
  z.object({
    modify: z.object({
      id: z.string(),
      at,
      arrival: date.optional(),
      departure: date.optional(),
      room: z.string().optional(),
      adults: z.number().int().optional(),
    }),
  }),
  z.object({
    cancel: z.object({ id: z.string(), outcome: z.enum(['CANCELLED', 'NO_SHOW']).optional() }),
  }),
  z.object({ checkin: z.object({ id: z.string(), room: z.string(), at }) }),
  z.object({ move: z.object({ id: z.string(), to: z.string(), at }) }),
  z.object({ guest: guest.partial().extend({ id: z.string(), at }) }),
  z.object({ checkout: z.object({ id: z.string(), at }) }),
  z.object({
    room_status: z.object({ room: z.string(), status: z.number().int().min(1).max(6), at }),
  }),
  z.object({
    chaos: z.object({
      duplicate_next: z.boolean().optional(),
      reorder_next: z.boolean().optional(),
      drop_connection: z.boolean().optional(),
    }),
  }),
  z.object({ wait_acked: z.object({ timeout_ms: z.number().int().optional() }).default({}) }),
]);

export const scenarioSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  timezone: z.string().default('Africa/Cairo'),
  faces: z
    .array(z.enum(['FIAS', 'OWS']))
    .min(1)
    .default(['FIAS', 'OWS']),
  steps: z.array(step).min(1),
});
export type Scenario = z.infer<typeof scenarioSchema>;

export function loadScenario(file: string): Scenario {
  return scenarioSchema.parse(parse(readFileSync(file, 'utf8')));
}

export async function runScenario(
  scenario: Scenario,
  pms: SimulatedPms,
  link: AgentLinkClient,
): Promise<void> {
  for (const s of scenario.steps) {
    if ('reserve' in s) pms.reserve(s.reserve);
    else if ('modify' in s) {
      const { id, at: when, ...changes } = s.modify;
      pms.modify(id, changes, when);
    } else if ('cancel' in s) pms.cancel(s.cancel.id, s.cancel.outcome);
    else if ('checkin' in s) pms.checkIn(s.checkin.id, s.checkin.room, s.checkin.at);
    else if ('move' in s) pms.move(s.move.id, s.move.to, s.move.at);
    else if ('guest' in s) {
      const { id, at: when, ...changes } = s.guest;
      pms.updateGuest(id, changes, when);
    } else if ('checkout' in s) pms.checkOut(s.checkout.id, s.checkout.at);
    else if ('room_status' in s)
      pms.roomStatus(s.room_status.room, s.room_status.status as 1, s.room_status.at);
    else if ('chaos' in s) {
      if (s.chaos.duplicate_next) link.chaos.duplicateNext = true;
      if (s.chaos.reorder_next) link.chaos.reorderNext = true;
      if (s.chaos.drop_connection) link.dropConnection();
    } else if ('wait_acked' in s) await link.drained(s.wait_acked.timeout_ms ?? 15_000);
  }
}
