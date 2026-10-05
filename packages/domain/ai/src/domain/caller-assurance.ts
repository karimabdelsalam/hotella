/**
 * How well the person on the other side is known (ADR-0025, owner decision Q27). `VERIFIED`: an identity verified by
 * activation, OTP or staff, with a live grant. `ROOM_CONTEXT`: a call from the room's phone — the room and its stay,
 * not necessarily the guest speaking.
 */
export type CallerAssurance = 'VERIFIED' | 'ROOM_CONTEXT';

/**
 * What the concierge may do for a room-context caller: serve the room (requests, room signals, complaints, hotel
 * knowledge, table availability) — never read the guest's details, book, cancel or anything of higher risk. Enforced as
 * the execution's tool allowlist, so the model cannot step outside it (rule 11).
 */
export const ROOM_CONTEXT_TOOLS: ReadonlySet<string> = new Set([
  'catalog.list_services',
  'operations.find_open_requests',
  'operations.create_service_request',
  'housekeeping.set_room_signal',
  'relations.suggest_complaint',
  'knowledge.search',
  'restaurant.find_tables',
  'communication.send_message',
]);

/** The agent's tools as a caller of this assurance may use them. */
export function toolsFor(tools: readonly string[], assurance: CallerAssurance): string[] {
  return assurance === 'VERIFIED' ? [...tools] : tools.filter((t) => ROOM_CONTEXT_TOOLS.has(t));
}

/** What the model is told about a room-context caller (data, not a privilege: the tool allowlist is what binds). */
export const ROOM_CONTEXT_NOTE = [
  "The caller is on the room's phone. That identifies the room and its stay, not the person speaking.",
  "Do not say the guest's name or any personal, booking or billing detail, and do not act on such requests.",
  'For anything personal or sensitive, hand off with reason SENSITIVE_REQUEST: the call goes to the operator, who verifies the caller.',
];
