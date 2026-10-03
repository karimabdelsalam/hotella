/**
 * Stay state machine (Spec §6, CLAUDE.md rules 11 and 19). Pure and deterministic: the PMS is the source of truth and
 * these rules only decide how its (possibly repeated or reordered) facts are applied.
 *
 *   EXPECTED ──check-in──▶ IN_HOUSE ──check-out──▶ CHECKED_OUT
 *      │                       ▲                       │
 *      └─cancel/no-show─▶ CANCELLED / NO_SHOW          └─ check-in newer than the check-out: reinstated
 *
 * - Status moves forward only, except a PMS reinstatement: a check-in (or reservation update) that happened AFTER the
 *   recorded check-out (or cancellation).
 * - A fact older than the newest one already applied never overwrites snapshot data (dates, party, codes).
 */

export type StayStatus = 'EXPECTED' | 'IN_HOUSE' | 'CHECKED_OUT' | 'CANCELLED' | 'NO_SHOW';

export interface StayFacts {
  readonly status: StayStatus;
  readonly actualCheckoutAt: Date | null;
  readonly cancelledAt: Date | null;
  readonly lastPmsEventAt: Date;
}

export type PmsFact =
  | { readonly kind: 'CHECKED_IN'; readonly at: Date }
  | { readonly kind: 'CHECKED_OUT'; readonly at: Date }
  | { readonly kind: 'RESERVATION'; readonly at: Date }
  | { readonly kind: 'CANCELLED'; readonly at: Date; readonly outcome: 'CANCELLED' | 'NO_SHOW' };

export interface Transition {
  /** New status (unchanged when equal to the current one). */
  readonly status: StayStatus;
  /** Whether snapshot data in the fact may overwrite stored data (it is not older than what was applied). */
  readonly applySnapshot: boolean;
  /** The check-out was undone by the PMS (reinstated stay): clear `actual_checkout_at`, reopen the room. */
  readonly reinstated: boolean;
}

export function transition(stay: StayFacts, fact: PmsFact): Transition {
  const applySnapshot = fact.at.getTime() >= stay.lastPmsEventAt.getTime();
  const keep = { status: stay.status, applySnapshot, reinstated: false };
  switch (fact.kind) {
    case 'CHECKED_IN':
      if (stay.status === 'IN_HOUSE') return keep;
      if (stay.status === 'CHECKED_OUT') {
        const reinstated = stay.actualCheckoutAt !== null && fact.at > stay.actualCheckoutAt;
        return reinstated ? { status: 'IN_HOUSE', applySnapshot, reinstated } : keep;
      }
      if (stay.status === 'CANCELLED' || stay.status === 'NO_SHOW') {
        const after = stay.cancelledAt === null || fact.at > stay.cancelledAt;
        return after ? { status: 'IN_HOUSE', applySnapshot, reinstated: false } : keep;
      }
      return { status: 'IN_HOUSE', applySnapshot, reinstated: false };
    case 'CHECKED_OUT':
      if (stay.status === 'IN_HOUSE' || stay.status === 'EXPECTED')
        return { status: 'CHECKED_OUT', applySnapshot, reinstated: false };
      return keep;
    case 'CANCELLED':
      if (stay.status === 'EXPECTED')
        return { status: fact.outcome, applySnapshot, reinstated: false };
      return keep;
    case 'RESERVATION':
      if ((stay.status === 'CANCELLED' || stay.status === 'NO_SHOW') && stay.cancelledAt) {
        return fact.at > stay.cancelledAt
          ? { status: 'EXPECTED', applySnapshot, reinstated: false }
          : keep;
      }
      return keep;
  }
}

/** The stay is current at the property (its room shows it as occupied by this stay). */
export function isActive(status: StayStatus): boolean {
  return status === 'IN_HOUSE';
}
