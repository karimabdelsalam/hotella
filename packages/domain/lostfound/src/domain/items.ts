/**
 * Lost & Found rules (Spec §13, BUILD_PLAN 9.B): an item's lifecycle and how a found item is matched to a lost one.
 * Deterministic (CLAUDE.md rule 11): the score and its reasons are computed here, never by a model; AI-derived
 * attributes only fill in what the staff did not record, and count for less.
 */

export const ITEM_KINDS = ['FOUND', 'LOST'] as const;
export type ItemKind = (typeof ITEM_KINDS)[number];

export const ITEM_STATUSES = ['REGISTERED', 'MATCHED', 'CLAIMED', 'RELEASED', 'DISPOSED'] as const;
export type ItemStatus = (typeof ITEM_STATUSES)[number];

export const ITEM_CATEGORIES = [
  'ELECTRONICS',
  'PHONE',
  'JEWELLERY',
  'WATCH',
  'CLOTHING',
  'BAG',
  'DOCUMENT',
  'MONEY',
  'KEYS',
  'GLASSES',
  'TOILETRIES',
  'TOY',
  'OTHER',
] as const;
export type ItemCategory = (typeof ITEM_CATEGORIES)[number];

export const COLOURS = [
  'BLACK',
  'WHITE',
  'GREY',
  'SILVER',
  'GOLD',
  'RED',
  'PINK',
  'ORANGE',
  'YELLOW',
  'GREEN',
  'BLUE',
  'PURPLE',
  'BROWN',
  'BEIGE',
  'MULTI',
] as const;
export type Colour = (typeof COLOURS)[number];

/** Items that go to the safe and need a witness on release (documents, money, jewellery, phones…). */
const VALUABLE = new Set<ItemCategory>([
  'PHONE',
  'JEWELLERY',
  'WATCH',
  'DOCUMENT',
  'MONEY',
  'ELECTRONICS',
]);
export function isValuable(category: ItemCategory): boolean {
  return VALUABLE.has(category);
}

export const DISPOSAL_METHODS = [
  'DONATED',
  'DESTROYED',
  'HANDED_TO_AUTHORITIES',
  'GIVEN_TO_FINDER',
] as const;
export type DisposalMethod = (typeof DISPOSAL_METHODS)[number];

/** Found items wait to be claimed; lost reports wait to be matched. Released, claimed and disposed are final. */
export function isOpen(status: ItemStatus): boolean {
  return status === 'REGISTERED' || status === 'MATCHED';
}

export interface MatchSide {
  readonly category: ItemCategory;
  readonly colour: Colour | null;
  readonly brand: string | null;
  readonly locationId: string | null;
  /** When it was found, or when the guest thinks they lost it. */
  readonly at: Date;
  /** Attributes a model derived from the description (never the staff's own words). */
  readonly ai?: { readonly colours: readonly string[]; readonly brand: string | null } | null;
}

export type MatchReason =
  'CATEGORY' | 'COLOUR' | 'COLOUR_AI' | 'BRAND' | 'BRAND_AI' | 'LOCATION' | 'DATE_CLOSE';

/** A found item can be at most this long before the loss was noticed (clocks and memories differ)… */
const FOUND_BEFORE_LOST_MS = 1 * 86_400_000;
/** …and at most this long after it. */
const FOUND_AFTER_LOST_MS = 30 * 86_400_000;
const CLOSE_MS = 2 * 86_400_000;
export const MATCH_MIN_SCORE = 50;

const norm = (s: string | null | undefined) =>
  (s ?? '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\p{L}\p{N}]+/gu, '');

/**
 * Scores a found item against a lost report: same category is required, the found date must fall in the window, then
 * colour, brand, place and closeness add up. Staff-recorded attributes weigh more than AI-derived ones.
 */
export function matchScore(
  found: MatchSide,
  lost: MatchSide,
): { readonly score: number; readonly reasons: readonly MatchReason[] } | null {
  if (found.category !== lost.category) return null;
  const gap = found.at.getTime() - lost.at.getTime();
  if (gap < -FOUND_BEFORE_LOST_MS || gap > FOUND_AFTER_LOST_MS) return null;
  const reasons: MatchReason[] = ['CATEGORY'];
  let score = 40;

  if (found.colour && lost.colour) {
    if (found.colour === lost.colour) {
      score += 20;
      reasons.push('COLOUR');
    } else score -= 20;
  } else {
    const a = found.colour ? [found.colour] : (found.ai?.colours ?? []);
    const b = lost.colour ? [lost.colour] : (lost.ai?.colours ?? []);
    if (a.some((c) => b.includes(c))) {
      score += 10;
      reasons.push('COLOUR_AI');
    }
  }

  const fb = norm(found.brand);
  const lb = norm(lost.brand);
  if (fb && lb) {
    if (fb === lb) {
      score += 20;
      reasons.push('BRAND');
    } else score -= 20;
  } else {
    const a = fb || norm(found.ai?.brand);
    const b = lb || norm(lost.ai?.brand);
    if (a && a === b) {
      score += 10;
      reasons.push('BRAND_AI');
    }
  }

  if (found.locationId && lost.locationId && found.locationId === lost.locationId) {
    score += 15;
    reasons.push('LOCATION');
  }
  if (Math.abs(gap) <= CLOSE_MS) {
    score += 10;
    reasons.push('DATE_CLOSE');
  }
  return score >= MATCH_MIN_SCORE ? { score: Math.min(score, 100), reasons } : null;
}

/** When an unclaimed found item may be disposed of (UTC date, `YYYY-MM-DD`). */
export function retentionUntil(foundAt: Date, days: number): string {
  return new Date(foundAt.getTime() + days * 86_400_000).toISOString().slice(0, 10);
}
