import type { ConnectorCapability } from '@hotella/contracts-connectors';
import { OPERA_DB, OPERA_FIAS, OPERA_OWS } from './capabilities';

/**
 * Commissioning (ADR-0019; OPERA Integration Guide §16, §20; BUILD_PLAN 10.9): the hotel is compared with the
 * standard, never the other way round. The Interface Sheet requirements and the pilot readiness checklist are code;
 * the checklist is a pure function of facts (CLAUDE.md rule 11). Labels are locale keys
 * (`staff.control.commissioning.requirement.<code>` / `.item.<code>` / `.reason.<code>`).
 */

/** Which part of the hotel a requirement is about: one connector, or the site as a whole. */
export type RequirementScope = typeof OPERA_FIAS | typeof OPERA_OWS | typeof OPERA_DB | 'SITE';

export interface CommissioningRequirement {
  readonly code: string;
  readonly scope: RequirementScope;
  /** Must be MATCH (or NOT_APPLICABLE) before the property is ready. */
  readonly required: boolean;
  /** What a GAP leaves off (guide §16.2 "capability impact"). */
  readonly capabilities: readonly ConnectorCapability[];
}

export const SHEET_STATUSES = ['MATCH', 'GAP', 'CHANGE_REQUIRED', 'NOT_APPLICABLE'] as const;
export type SheetStatus = (typeof SHEET_STATUSES)[number];

/** Interface Sheet rows (guide §16.2) and the site items of the readiness checklist (§20). */
export const COMMISSIONING_REQUIREMENTS: readonly CommissioningRequirement[] = [
  {
    code: 'FIAS_INTERFACE',
    scope: OPERA_FIAS,
    required: true,
    capabilities: ['CHECKIN_EVENT', 'CHECKOUT_EVENT', 'ROOM_MOVE_EVENT', 'PROFILE_EVENT'],
  },
  { code: 'FIAS_CONNECTION', scope: OPERA_FIAS, required: true, capabilities: [] },
  {
    code: 'FIAS_GUEST_RECORDS',
    scope: OPERA_FIAS,
    required: true,
    capabilities: ['CHECKIN_EVENT', 'CHECKOUT_EVENT', 'ROOM_MOVE_EVENT', 'PROFILE_EVENT'],
  },
  {
    code: 'FIAS_RE_TO_INTERFACE',
    scope: OPERA_FIAS,
    required: false,
    capabilities: ['ROOM_STATUS_READ'],
  },
  {
    code: 'FIAS_RE_FROM_INTERFACE',
    scope: OPERA_FIAS,
    required: false,
    capabilities: ['ROOM_STATUS_WRITE'],
  },
  {
    code: 'FIAS_DATABASE_SWAP',
    scope: OPERA_FIAS,
    required: true,
    capabilities: ['RECONCILIATION_READ'],
  },
  { code: 'FIAS_CHARSET', scope: OPERA_FIAS, required: true, capabilities: [] },
  { code: 'FIAS_AUTH_KEY', scope: OPERA_FIAS, required: true, capabilities: [] },
  { code: 'FIAS_INTERFACE_ID', scope: OPERA_FIAS, required: true, capabilities: [] },
  {
    code: 'OWS_LICENCE',
    scope: OPERA_OWS,
    required: true,
    capabilities: ['RESERVATION_READ', 'RESERVATION_LOOKUP', 'ARRIVALS_READ', 'PROFILE_LOOKUP'],
  },
  { code: 'OWS_ENDPOINT', scope: OPERA_OWS, required: true, capabilities: [] },
  { code: 'OWS_ENTITIES', scope: OPERA_OWS, required: true, capabilities: [] },
  { code: 'OWS_USER', scope: OPERA_OWS, required: true, capabilities: ['PROFILE_WRITE'] },
  {
    code: 'DB_ACCOUNT',
    scope: OPERA_DB,
    required: true,
    capabilities: [
      'RESERVATION_LOOKUP',
      'ARRIVALS_READ',
      'IN_HOUSE_SNAPSHOT',
      'ROOM_INVENTORY_READ',
    ],
  },
  { code: 'DB_NETWORK', scope: OPERA_DB, required: true, capabilities: [] },
  { code: 'SITE_VERSIONS', scope: 'SITE', required: true, capabilities: [] },
  { code: 'SITE_AGENT_HOST', scope: 'SITE', required: true, capabilities: [] },
  { code: 'SITE_ONSITE_TESTS', scope: 'SITE', required: true, capabilities: [] },
  { code: 'SITE_ROLLBACK', scope: 'SITE', required: true, capabilities: [] },
];

const BY_CODE = new Map(COMMISSIONING_REQUIREMENTS.map((r) => [r.code, r]));

export function requirement(code: string): CommissioningRequirement | undefined {
  return BY_CODE.get(code);
}

// ---- verification runs ----

export type CheckOutcome = 'PASS' | 'FAIL' | 'SKIPPED';

/** One check of a verification run: counts and reason codes only, never guest data. */
export interface RunCheck {
  readonly code: string;
  readonly outcome: CheckOutcome;
  readonly detail: Readonly<Record<string, string | number | boolean | null>>;
}

/** A run passes when no check failed and at least one ran. */
export function runStatus(checks: readonly RunCheck[]): 'PASSED' | 'FAILED' {
  return checks.some((c) => c.outcome === 'FAIL') || !checks.some((c) => c.outcome === 'PASS')
    ? 'FAILED'
    : 'PASSED';
}

// ---- readiness (guide §20) ----

export const READINESS_ITEMS = [
  'VERSIONS_RECORDED',
  'IFC8_INTERFACE',
  'SHEET_COMPARED',
  'OWS_KNOWN',
  'DB_ACCOUNT',
  'AGENT_HOST',
  'AGENTS_HEALTHY',
  'VERIFICATION_RUNS',
  'MAPPINGS_CONFIRMED',
  'CAPABILITIES_SIGNED_OFF',
  'ONSITE_TESTS',
  'ROLLBACK_AGREED',
] as const;
export type ReadinessItem = (typeof READINESS_ITEMS)[number];

export interface ReadinessReason {
  readonly code: string;
  /** What it is about: a requirement code, a connector code, `CONNECTOR:CAPABILITY`. */
  readonly subject?: string;
  readonly count?: number;
}

export interface ReadinessEntry {
  readonly item: ReadinessItem;
  readonly state: 'DONE' | 'OPEN' | 'NOT_APPLICABLE';
  readonly reasons: readonly ReadinessReason[];
}

export interface ReadinessInstance {
  readonly connectorCode: string;
  readonly active: boolean;
  readonly health: string | null;
  readonly licensed: boolean;
  readonly commissioned: boolean;
  /** Capabilities the hotel uses on this instance (supported ∧ enabled ∧ not refused by the agent) still unverified. */
  readonly unverified: readonly ConnectorCapability[];
  readonly lastRun: 'PASSED' | 'FAILED' | null;
}

export interface ReadinessFacts {
  readonly instances: readonly ReadinessInstance[];
  /** Current sheet status per requirement code. */
  readonly sheet: ReadonlyMap<string, SheetStatus>;
  readonly openExceptions: number;
  readonly lastReconciliation: { readonly status: string; readonly differences: number } | null;
}

/** The pilot readiness checklist (guide §20) for one property; `ready` when nothing is OPEN. */
export function readiness(f: ReadinessFacts): {
  ready: boolean;
  items: ReadinessEntry[];
} {
  const active = f.instances.filter((i) => i.active);
  const present = (code: string) => active.some((i) => i.connectorCode === code);
  const scopes = new Set<RequirementScope>(['SITE']);
  for (const c of [OPERA_FIAS, OPERA_OWS, OPERA_DB] as const) if (present(c)) scopes.add(c);

  const rowsMatch = (codes: readonly string[]): ReadinessReason[] =>
    codes
      .filter((c) => {
        const s = f.sheet.get(c);
        return s !== 'MATCH' && s !== 'NOT_APPLICABLE';
      })
      .map((c) => ({
        code: f.sheet.has(c) ? 'SHEET_ROW_NOT_MATCHING' : 'SHEET_ROW_MISSING',
        subject: c,
      }));
  const entry = (
    item: ReadinessItem,
    applicable: boolean,
    reasons: readonly ReadinessReason[],
  ): ReadinessEntry => ({
    item,
    state: !applicable ? 'NOT_APPLICABLE' : reasons.length === 0 ? 'DONE' : 'OPEN',
    reasons: applicable ? reasons : [],
  });

  const required = COMMISSIONING_REQUIREMENTS.filter((r) => r.required && scopes.has(r.scope));
  const runs = (codes: readonly string[]) =>
    active
      .filter((i) => codes.includes(i.connectorCode))
      .flatMap((i): ReadinessReason[] =>
        i.lastRun === 'PASSED'
          ? []
          : [{ code: i.lastRun ? 'RUN_FAILED' : 'NO_RUN', subject: i.connectorCode }],
      );

  const items: ReadinessEntry[] = [
    entry('VERSIONS_RECORDED', true, rowsMatch(['SITE_VERSIONS'])),
    entry(
      'IFC8_INTERFACE',
      present(OPERA_FIAS),
      rowsMatch(['FIAS_INTERFACE', 'FIAS_INTERFACE_ID']),
    ),
    entry('SHEET_COMPARED', true, rowsMatch(required.map((r) => r.code))),
    entry(
      'OWS_KNOWN',
      present(OPERA_OWS),
      rowsMatch(['OWS_LICENCE', 'OWS_ENDPOINT', 'OWS_ENTITIES', 'OWS_USER']),
    ),
    entry('DB_ACCOUNT', present(OPERA_DB), [...rowsMatch(['DB_ACCOUNT']), ...runs([OPERA_DB])]),
    entry('AGENT_HOST', true, rowsMatch(['SITE_AGENT_HOST'])),
    entry(
      'AGENTS_HEALTHY',
      true,
      active.length === 0
        ? [{ code: 'NO_CONNECTOR' }]
        : active.flatMap((i): ReadinessReason[] => [
            ...(i.health === 'HEALTHY' ? [] : [{ code: 'NOT_HEALTHY', subject: i.connectorCode }]),
            ...(i.licensed ? [] : [{ code: 'NOT_LICENSED', subject: i.connectorCode }]),
          ]),
    ),
    entry('VERIFICATION_RUNS', active.length > 0, runs(active.map((i) => i.connectorCode))),
    entry(
      'MAPPINGS_CONFIRMED',
      true,
      f.openExceptions > 0 ? [{ code: 'OPEN_EXCEPTIONS', count: f.openExceptions }] : [],
    ),
    entry(
      'CAPABILITIES_SIGNED_OFF',
      active.length > 0,
      active.flatMap((i): ReadinessReason[] => [
        ...(i.commissioned ? [] : [{ code: 'NOT_COMMISSIONED', subject: i.connectorCode }]),
        ...i.unverified.map((c) => ({ code: 'NOT_VERIFIED', subject: `${i.connectorCode}:${c}` })),
      ]),
    ),
    entry('ONSITE_TESTS', true, [
      ...rowsMatch(['SITE_ONSITE_TESTS']),
      ...(!f.lastReconciliation
        ? [{ code: 'NO_RECONCILIATION' }]
        : f.lastReconciliation.status !== 'COMPLETED'
          ? [{ code: 'RECONCILIATION_NOT_COMPLETED', subject: f.lastReconciliation.status }]
          : f.lastReconciliation.differences > 0
            ? [{ code: 'RECONCILIATION_DIFFERENCES', count: f.lastReconciliation.differences }]
            : []),
    ]),
    entry('ROLLBACK_AGREED', true, rowsMatch(['SITE_ROLLBACK'])),
  ];
  return { ready: items.every((i) => i.state !== 'OPEN'), items };
}
