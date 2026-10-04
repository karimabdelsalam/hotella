import { describe, expect, it } from 'vitest';
import {
  COMMISSIONING_REQUIREMENTS,
  readiness,
  type ReadinessFacts,
  type ReadinessInstance,
  runStatus,
  type SheetStatus,
} from './commissioning';

const instance = (
  connectorCode: string,
  over: Partial<ReadinessInstance> = {},
): ReadinessInstance => ({
  connectorCode,
  active: true,
  health: 'HEALTHY',
  licensed: true,
  commissioned: true,
  unverified: [],
  lastRun: 'PASSED',
  ...over,
});

/** Every requirement of the given scopes stated MATCH. */
function sheet(...scopes: string[]): Map<string, SheetStatus> {
  return new Map(
    COMMISSIONING_REQUIREMENTS.filter((r) => scopes.includes(r.scope)).map((r) => [
      r.code,
      'MATCH' as SheetStatus,
    ]),
  );
}

const ready = (instances: ReadinessInstance[], scopes: string[]): ReadinessFacts => ({
  instances,
  sheet: sheet('SITE', ...scopes),
  openExceptions: 0,
  lastReconciliation: { status: 'COMPLETED', differences: 0 },
});

const open = (r: ReturnType<typeof readiness>) =>
  r.items.filter((i) => i.state === 'OPEN').map((i) => i.item);

describe('commissioning readiness (guide §20)', () => {
  it('hotels A, B and C are ready once their own connectors are commissioned', () => {
    const a = readiness(
      ready([instance('OPERA5_DB'), instance('OPERA5_FIAS')], ['OPERA5_DB', 'OPERA5_FIAS']),
    );
    expect(a.ready).toBe(true);
    // Hotel A has no OWS: that item does not apply, it is not "done".
    expect(a.items.find((i) => i.item === 'OWS_KNOWN')).toMatchObject({ state: 'NOT_APPLICABLE' });
    const b = readiness(
      ready(
        [instance('OPERA5_DB'), instance('OPERA5_FIAS'), instance('OPERA5_OWS')],
        ['OPERA5_DB', 'OPERA5_FIAS', 'OPERA5_OWS'],
      ),
    );
    expect(b.ready).toBe(true);
    const c = readiness(
      ready([instance('OPERA5_FIAS'), instance('OPERA5_OWS')], ['OPERA5_FIAS', 'OPERA5_OWS']),
    );
    expect(c.ready).toBe(true);
    expect(c.items.find((i) => i.item === 'DB_ACCOUNT')).toMatchObject({
      state: 'NOT_APPLICABLE',
    });
  });

  it('a fresh property is not ready, and says why item by item', () => {
    const r = readiness({
      instances: [
        instance('OPERA5_FIAS', {
          health: 'OFFLINE',
          commissioned: false,
          unverified: ['CHECKIN_EVENT'],
          lastRun: null,
        }),
      ],
      sheet: new Map(),
      openExceptions: 2,
      lastReconciliation: null,
    });
    expect(r.ready).toBe(false);
    expect(open(r)).toEqual([
      'VERSIONS_RECORDED',
      'IFC8_INTERFACE',
      'SHEET_COMPARED',
      'AGENT_HOST',
      'AGENTS_HEALTHY',
      'VERIFICATION_RUNS',
      'MAPPINGS_CONFIRMED',
      'CAPABILITIES_SIGNED_OFF',
      'ONSITE_TESTS',
      'ROLLBACK_AGREED',
    ]);
    const item = (code: string) => r.items.find((i) => i.item === code)!;
    expect(item('AGENTS_HEALTHY').reasons).toEqual([
      { code: 'NOT_HEALTHY', subject: 'OPERA5_FIAS' },
    ]);
    expect(item('MAPPINGS_CONFIRMED').reasons).toEqual([{ code: 'OPEN_EXCEPTIONS', count: 2 }]);
    expect(item('CAPABILITIES_SIGNED_OFF').reasons).toEqual([
      { code: 'NOT_COMMISSIONED', subject: 'OPERA5_FIAS' },
      { code: 'NOT_VERIFIED', subject: 'OPERA5_FIAS:CHECKIN_EVENT' },
    ]);
    expect(item('ONSITE_TESTS').reasons).toEqual([
      { code: 'SHEET_ROW_MISSING', subject: 'SITE_ONSITE_TESTS' },
      { code: 'NO_RECONCILIATION' },
    ]);
    // Only the requirements of present connectors are asked for.
    expect(item('SHEET_COMPARED').reasons.map((x) => x.subject)).not.toContain('OWS_LICENCE');
  });

  it('a GAP or change request on a required row keeps it open; NOT_APPLICABLE and optional rows do not', () => {
    const facts = ready([instance('OPERA5_FIAS')], ['OPERA5_FIAS']);
    const s = new Map(facts.sheet);
    s.set('FIAS_DATABASE_SWAP', 'CHANGE_REQUIRED');
    s.set('FIAS_RE_FROM_INTERFACE', 'GAP');
    s.set('FIAS_AUTH_KEY', 'NOT_APPLICABLE');
    const r = readiness({ ...facts, sheet: s });
    expect(open(r)).toEqual(['SHEET_COMPARED']);
    expect(r.items.find((i) => i.item === 'SHEET_COMPARED')!.reasons).toEqual([
      { code: 'SHEET_ROW_NOT_MATCHING', subject: 'FIAS_DATABASE_SWAP' },
    ]);
  });

  it('the DB needs its account statement and a passed run; reconciliation differences keep tests open', () => {
    const r = readiness({
      ...ready([instance('OPERA5_DB', { lastRun: 'FAILED' })], ['OPERA5_DB']),
      lastReconciliation: { status: 'COMPLETED', differences: 1 },
    });
    expect(r.items.find((i) => i.item === 'DB_ACCOUNT')!.reasons).toEqual([
      { code: 'RUN_FAILED', subject: 'OPERA5_DB' },
    ]);
    expect(r.items.find((i) => i.item === 'ONSITE_TESTS')!.reasons).toEqual([
      { code: 'RECONCILIATION_DIFFERENCES', count: 1 },
    ]);
  });

  it('inactive instances are not part of the property; without any the agents item is open', () => {
    const r = readiness(ready([instance('OPERA5_OWS', { active: false })], []));
    expect(r.items.find((i) => i.item === 'AGENTS_HEALTHY')!.reasons).toEqual([
      { code: 'NO_CONNECTOR' },
    ]);
    expect(r.items.find((i) => i.item === 'OWS_KNOWN')!.state).toBe('NOT_APPLICABLE');
  });
});

describe('commissioning catalog and runs', () => {
  it('requirement codes are unique and name only known scopes', () => {
    const codes = COMMISSIONING_REQUIREMENTS.map((r) => r.code);
    expect(new Set(codes).size).toBe(codes.length);
    for (const r of COMMISSIONING_REQUIREMENTS)
      expect(['OPERA5_FIAS', 'OPERA5_OWS', 'OPERA5_DB', 'SITE']).toContain(r.scope);
  });

  it('a run passes only when something passed and nothing failed', () => {
    expect(runStatus([{ code: 'A', outcome: 'PASS', detail: {} }])).toBe('PASSED');
    expect(
      runStatus([
        { code: 'A', outcome: 'PASS', detail: {} },
        { code: 'B', outcome: 'FAIL', detail: {} },
      ]),
    ).toBe('FAILED');
    expect(runStatus([{ code: 'A', outcome: 'SKIPPED', detail: {} }])).toBe('FAILED');
  });
});
