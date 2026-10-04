import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { and, eq } from 'drizzle-orm';
import type { EventEnvelope } from '@hotella/contracts-events';
import { reconcileOnce, StayReconciler } from '@hotella/domain-guest';
import { eventsSchema, IdempotentConsumer } from '@hotella/platform-events';
import {
  infraSkipReason,
  needsDotnetAgent,
  needsInfra,
  readTestInfra,
} from '@hotella/platform-testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseFixture, Ifc8Face, OwsSoapFace, SimulatedPms } from '../src';
import { agentBinaries, DotnetAgent } from './dotnet-agent';
import { admin, type GatewayHarness, startGatewayHarness, until } from './gateway-harness';

/**
 * OPERA integration acceptance (BUILD_PLAN 10.9; guide §16, §20): a hotel of shape B — the read-only OPERA database,
 * IFC8/FIAS and OWS, each through its own .NET agent against the simulator — is taken from nothing to `ready` through
 * the commissioning API alone: the Interface Sheet, verification runs, capability sign-off, a reconciliation, the
 * readiness checklist. On the way, the three connectors behave as one PMS: a reservation seen by OWS is the stay that
 * FIAS checks in. At the pilot only the hotel's values change. Skipped without a built agent (TEST_DOTNET_AGENT).
 */
const artifacts = readTestInfra().dotnetAgent;
const skip = needsDotnetAgent();
const reason = needsInfra() ? infraSkipReason() : 'TEST_DOTNET_AGENT not set';
const stamp = Date.now().toString(36).toUpperCase();
const FIAS = [
  'CHECKIN_EVENT',
  'CHECKOUT_EVENT',
  'ROOM_MOVE_EVENT',
  'PROFILE_EVENT',
  'RECONCILIATION_READ',
];
const DB = [
  'RESERVATION_READ',
  'RESERVATION_LOOKUP',
  'ARRIVALS_READ',
  'IN_HOUSE_SNAPSHOT',
  'GUEST_READ',
  'PROFILE_LOOKUP',
  'ROOM_INVENTORY_READ',
  'RECONCILIATION_READ',
];
const OWS = [
  'RESERVATION_READ',
  'RESERVATION_LOOKUP',
  'ARRIVALS_READ',
  'GUEST_READ',
  'PROFILE_LOOKUP',
];
const OWS_USER = 'HOTELLA';
const OWS_PASSWORD = `ows-${stamp}`;
const today = () => new Date().toISOString().slice(0, 10);
const inDays = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);

interface Commissioning {
  ready: boolean;
  checklist: Array<{ item: string; state: string; reasons: Array<Record<string, unknown>> }>;
  sheet: Array<{ requirement: string; scope: string; current: { status: string } | null }>;
  instances: Array<{
    id: string;
    connectorCode: string;
    health: string | null;
    unverified: string[];
    commissionedAt: string | null;
  }>;
}

describe.skipIf(skip)(
  `OPERA commissioning: hotel B (DB + IFC8 + OWS) to ready (${skip ? reason : 'dotnet'})`,
  () => {
    let h: GatewayHarness;
    let pms: SimulatedPms;
    let ifc8: Ifc8Face;
    let owsFace: OwsSoapFace;
    const agents: DotnetAgent[] = [];
    const instance: Record<'fias' | 'db' | 'ows', string> = { fias: '', db: '', ows: '' };
    const dir = mkdtempSync(join(tmpdir(), 'opera-commissioning-'));
    const fixture = join(dir, 'opera.json');
    const id = (x: string) => `CM-${x}-${stamp}`;
    const save = () => writeFileSync(fixture, JSON.stringify(databaseFixture(pms, 'SIM')));
    const base = () => `${h.base}/integration`;
    const commissioning = async () =>
      (await h.http().get(`${base()}/commissioning`).set('X-Test-Actor', admin).expect(200))
        .body as Commissioning;
    const stays = async () => {
      await h.projectAll();
      return (await h.http().get(`${h.base}/stays`).set('X-Test-Actor', h.gm).expect(200))
        .body as Array<{ id: string; status: string }>;
    };

    beforeAll(async () => {
      h = await startGatewayHarness(readTestInfra().databaseUrl!, `cm-${stamp}`, {
        connectorCode: 'OPERA5_FIAS',
        capabilities: FIAS,
      });
      instance.fias = h.instanceId;
      const db = await h.addInstance('OPERA5_DB', DB);
      const ows = await h.addInstance('OPERA5_OWS', OWS);
      instance.db = db.instanceId;
      instance.ows = ows.instanceId;

      pms = new SimulatedPms({
        timezone: 'Africa/Cairo',
        faces: new Set(['FIAS']),
        emit: (m) => {
          if (m.message_type === 'FIAS_RECORD') ifc8.send((m.payload as { record: string }).record);
        },
      });
      ifc8 = new Ifc8Face(pms);
      const port = await ifc8.listen();
      owsFace = new OwsSoapFace(pms, { user: OWS_USER, password: OWS_PASSWORD });
      const owsUrl = await owsFace.listen();
      save();

      const start = async (
        token: string,
        connector: string,
        capabilities: string[],
        options: Parameters<DotnetAgent['start']>[3],
      ) => {
        const agent = new DotnetAgent(agentBinaries(artifacts).conformance);
        agents.push(agent);
        await agent.enroll(h.gatewayUrl, token, h.caPem);
        await agent.start(connector, capabilities, [], options);
        await until(async () => (await agent.state()).connected);
      };
      await start(await h.enrollmentToken(), 'OPERA5_FIAS', FIAS, {
        ifc8: { host: '127.0.0.1', port },
      });
      await start(await db.enrollmentToken(), 'OPERA5_DB', DB, {
        opera_db: { fixture, resort: 'SIM' },
      });
      await start(await ows.enrollmentToken(), 'OPERA5_OWS', OWS, {
        ows: { url: owsUrl, user: OWS_USER, password: OWS_PASSWORD, poll_seconds: 1 },
      });
    }, 120_000);
    afterAll(async () => {
      for (const a of agents) await a.quit();
      await ifc8?.close();
      await owsFace?.close();
      await h?.app.close();
      rmSync(dir, { recursive: true, force: true });
    });

    it('a fresh hotel B is not ready, and the checklist says why', async () => {
      const c = await commissioning();
      expect(c.ready).toBe(false);
      expect(c.instances.map((i) => i.connectorCode).sort()).toEqual([
        'OPERA5_DB',
        'OPERA5_FIAS',
        'OPERA5_OWS',
      ]);
      const open = c.checklist.filter((i) => i.state === 'OPEN').map((i) => i.item);
      expect(open).toEqual(
        expect.arrayContaining(['SHEET_COMPARED', 'VERIFICATION_RUNS', 'CAPABILITIES_SIGNED_OFF']),
      );
      // Every connector of the hotel has its rows on the sheet; nothing is stated yet.
      expect(new Set(c.sheet.map((r) => r.scope))).toEqual(
        new Set(['OPERA5_FIAS', 'OPERA5_OWS', 'OPERA5_DB', 'SITE']),
      );
      expect(c.sheet.every((r) => r.current === null)).toBe(true);
    });

    it('the three connectors are one PMS: the reservation OWS forwarded is the stay FIAS checks in', async () => {
      pms.reserve({
        id: id('A'),
        guest: { profileId: `P-A-${stamp}`, first: 'Amira', last: 'Nile' },
        arrival: today(),
        departure: inDays(3),
      });
      pms.reserve({
        id: id('B'),
        guest: { profileId: `P-B-${stamp}`, first: 'Karim', last: 'Adel' },
        arrival: today(),
        departure: inDays(1),
      });
      save();
      // OWS polls the arrival window: two expected stays.
      await until(async () => (await stays()).length === 2, 30_000);
      expect((await stays()).map((s) => s.status)).toEqual(['EXPECTED', 'EXPECTED']);

      pms.checkIn(id('A'), '504');
      pms.checkIn(id('B'), '505');
      pms.checkOut(id('B'));
      save();
      await until(async () => {
        const list = await stays();
        return (
          list.length === 2 &&
          list.some((s) => s.status === 'IN_HOUSE') &&
          list.some((s) => s.status === 'CHECKED_OUT')
        );
      }, 30_000);
      // Still two stays: FIAS found OWS's stays through the shared OPERA reservation ids.
      expect((await stays()).map((s) => s.status).sort()).toEqual(['CHECKED_OUT', 'IN_HOUSE']);
    });

    it('the installer takes it to ready through the commissioning API alone', async () => {
      const as = (req: ReturnType<ReturnType<GatewayHarness['http']>['get']>) =>
        req.set('X-Test-Actor', admin);
      // 1. The Interface Sheet: this hotel matches the standard on every row.
      for (const row of (await commissioning()).sheet)
        await as(h.http().put(`${base()}/commissioning/sheet/${row.requirement}`))
          .send({ status: 'MATCH', hotelValue: 'as standard v1' })
          .expect(200);

      // 2. Verification runs against each agent (DB and OWS with the hotel's test reservation).
      const confirmation = pms.reservations.get(id('A'))!.confirmation;
      for (const [key, sample] of [
        ['db', { confirmationNumber: confirmation, profileId: `P-A-${stamp}` }],
        ['ows', { confirmationNumber: confirmation, profileId: `P-A-${stamp}` }],
        ['fias', undefined],
      ] as const) {
        const run = (
          await as(h.http().post(`${base()}/commissioning/runs`))
            .send({ instanceId: instance[key], ...(sample ? { sample } : {}) })
            .expect(200)
        ).body as { status: string; checks: Array<{ code: string; outcome: string }> };
        expect({ key, status: run.status, checks: run.checks }).toMatchObject({
          key,
          status: 'PASSED',
        });
      }

      // 3. Capability sign-off: every capability the hotel uses is verified, then each instance is commissioned.
      for (const i of (await commissioning()).instances) {
        for (const capability of i.unverified)
          await as(h.http().post(`${base()}/capabilities/${capability}/verify`))
            .send({ instanceId: i.id, evidenceRef: `COMM-${i.connectorCode}-${capability}` })
            .expect(200);
        await as(h.http().post(`${base()}/instances/${i.id}/commission`))
          .send({ evidenceRef: `COMM-${i.connectorCode}-signoff` })
          .expect(200);
      }

      // 4. On-site test: a reconciliation from the database snapshot compares with the stays FIAS and OWS made.
      const run = await h
        .http()
        .post(`${h.base}/integrations/${instance.db}/reconciliations`)
        .set('X-Test-Actor', h.gm)
        .expect(201);
      const snapshot = await until(async () => {
        const rows = await h.db
          .select()
          .from(eventsSchema.outbox)
          .where(
            and(
              eq(eventsSchema.outbox.aggregateId, run.body.id),
              eq(eventsSchema.outbox.eventType, 'integration.reconciliation.snapshot_completed'),
            ),
          );
        return rows[0];
      }, 20_000);
      const reconcile = reconcileOnce(h.app.get(IdempotentConsumer), h.app.get(StayReconciler));
      expect(await reconcile(snapshot.envelope as EventEnvelope)).toBe('processed');
      const result = await h
        .http()
        .get(`${h.base}/integrations/${instance.db}/reconciliations/${run.body.id}`)
        .set('X-Test-Actor', h.gm)
        .expect(200);
      expect(result.body).toMatchObject({ status: 'COMPLETED', summary: { MATCH: 1 } });

      // 5. The pilot readiness checklist (guide §20).
      const done = await until(async () => {
        const c = await commissioning();
        return c.ready ? c : undefined;
      }, 30_000).catch(async () => {
        const c = await commissioning();
        throw new Error(
          `not ready: ${JSON.stringify(c.checklist.filter((i) => i.state === 'OPEN'))}`,
        );
      });
      expect(done.checklist.every((i) => i.state === 'DONE')).toBe(true);
      expect(done.instances.every((i) => i.commissionedAt && i.unverified.length === 0)).toBe(true);
    });
  },
);
