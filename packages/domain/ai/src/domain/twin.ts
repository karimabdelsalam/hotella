/**
 * The operational twin (Spec §37, BUILD_PLAN 12.3): a projection of how the hotel's things are connected right now —
 * and were connected before — built from domain events. It holds ids, states and codes, never names or free text
 * (names are looked up when someone with the right permission reads it). It is a read model: never the source of truth.
 */

export const TWIN_KINDS = [
  'LOCATION',
  'STAY',
  'GUEST',
  'ASSET',
  'WORK_ITEM',
  'WORK_ORDER',
  'SERVICE_REQUEST',
  'COMPLAINT',
  'CONVERSATION',
  'INSPECTION',
  'LOST_ITEM',
  'STAFF',
  // A closed POS check tied to a stay (BUILD_PLAN 13.5): spend, never items or names.
  'POS_CHECK',
] as const;
export type TwinKind = (typeof TWIN_KINDS)[number];

/** Directed relations `from —relation→ to`; a traversal follows them both ways. */
export const TWIN_RELATIONS = [
  'HAS_GUEST', // STAY → GUEST
  'IN_ROOM', // STAY → LOCATION (one at a time)
  'AT', // WORK_ITEM / WORK_ORDER / SERVICE_REQUEST / INSPECTION / ASSET → LOCATION
  'FOR_STAY', // WORK_ITEM / SERVICE_REQUEST / COMPLAINT / CONVERSATION / LOST_ITEM → STAY
  'BY_GUEST', // SERVICE_REQUEST / CONVERSATION → GUEST
  'ASSIGNED_TO', // WORK_ITEM → STAFF
  'TRACKS', // WORK_ORDER / SERVICE_REQUEST → WORK_ITEM (the operational work behind it)
  'ON_ASSET', // WORK_ORDER / INSPECTION → ASSET
  'RAISED', // INSPECTION → WORK_ITEM (a finding's urgent work)
  'HAS_CHARGE', // STAY → POS_CHECK
] as const;
export type TwinRelation = (typeof TWIN_RELATIONS)[number];

export interface TwinRef {
  readonly kind: TwinKind;
  readonly id: string;
}

/** What one event changes in the twin. */
export type TwinOp =
  | {
      readonly op: 'node';
      readonly ref: TwinRef;
      readonly state?: string;
      /** Codes only (service, category, failure…), merged into what the node has. */
      readonly attributes?: Readonly<Record<string, string | number | boolean | null>>;
    }
  /** Opens an edge (no-op when the same edge is open). `exclusive`: other open edges of this relation from `from` end. */
  | {
      readonly op: 'link';
      readonly from: TwinRef;
      readonly relation: TwinRelation;
      readonly to: TwinRef;
      readonly exclusive?: boolean;
    }
  /** Ends an open edge; with `to` omitted, every open edge of this relation from `from`. */
  | {
      readonly op: 'unlink';
      readonly from: TwinRef;
      readonly relation: TwinRelation;
      readonly to?: TwinRef;
    };

export interface TwinEdge {
  readonly from: TwinRef;
  readonly relation: TwinRelation;
  readonly to: TwinRef;
  readonly validFrom: Date;
  readonly validTo: Date | null;
}

export const MAX_DEPTH = 3;
export const MAX_NODES = 200;

const key = (r: TwinRef) => `${r.kind}:${r.id}`;
const order = (a: TwinRef, b: TwinRef) =>
  a.kind === b.kind ? (a.id < b.id ? -1 : a.id > b.id ? 1 : 0) : a.kind < b.kind ? -1 : 1;

/**
 * The connected neighbourhood of a thing, breadth first up to `depth` hops (1–3), deterministic: the same twin gives
 * the same answer, in the same order. `edgesOf` answers the edges touching the given nodes (valid at the asked
 * moment). Stops adding nodes at `MAX_NODES` and says so.
 */
export async function neighbourhood(
  start: TwinRef,
  depth: number,
  edgesOf: (refs: readonly TwinRef[]) => Promise<readonly TwinEdge[]>,
): Promise<{
  readonly nodes: ReadonlyArray<TwinRef & { readonly distance: number }>;
  readonly edges: readonly TwinEdge[];
  readonly truncated: boolean;
}> {
  const hops = Math.max(1, Math.min(MAX_DEPTH, Math.trunc(depth)));
  const seen = new Map<string, TwinRef & { distance: number }>([
    [key(start), { ...start, distance: 0 }],
  ]);
  const edges = new Map<string, TwinEdge>();
  let frontier: TwinRef[] = [start];
  let truncated = false;
  for (let d = 1; d <= hops && frontier.length > 0; d++) {
    const found = await edgesOf(frontier);
    const next: TwinRef[] = [];
    const sorted = [...found].sort(
      (a, b) =>
        order(a.from, b.from) ||
        order(a.to, b.to) ||
        (a.relation < b.relation ? -1 : a.relation > b.relation ? 1 : 0) ||
        a.validFrom.getTime() - b.validFrom.getTime(),
    );
    for (const edge of sorted) {
      for (const end of [edge.from, edge.to]) {
        if (seen.has(key(end))) continue;
        if (seen.size >= MAX_NODES) {
          truncated = true;
          continue;
        }
        seen.set(key(end), { ...end, distance: d });
        next.push(end);
      }
      if (seen.has(key(edge.from)) && seen.has(key(edge.to)))
        edges.set(
          `${key(edge.from)}>${edge.relation}>${key(edge.to)}@${edge.validFrom.getTime()}`,
          edge,
        );
    }
    frontier = next;
  }
  return {
    nodes: [...seen.values()].sort((a, b) => a.distance - b.distance || order(a, b)),
    edges: [...edges.values()],
    truncated,
  };
}
