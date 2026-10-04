import { and, eq } from 'drizzle-orm';
import type { EventEnvelope } from '@hotella/contracts-events';
import { reconcileOnce, StayReconciler } from '@hotella/domain-guest';
import { eventsSchema, IdempotentConsumer } from '@hotella/platform-events';
import { infraSkipReason, needsInfra, readTestInfra } from '@hotella/platform-testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Ifc8Face, SimulatedPms } from '../src';
import { agentBinaries, DotnetAgent } from './dotnet-agent';
import { type GatewayHarness, startGatewayHarness, until } from './gateway-harness';

/**
 * OPERA 5 through IFC8 FIAS (BUILD_PLAN 10.2, ADR-0014), end to end over the wire: the simulator's IFC8 face speaks
 * FIAS over TCP (STX/ETX frames, LS/LD/LR/LA, database sync, RE) to the .NET agent's FIAS adapter, which forwards the
 * records through the durable mutual-TLS link to the real gateway as an `OPERA5_FIAS` instance. Skipped without a
 * built agent (TEST_DOTNET_AGENT), like the link conformance suite.
 */
const artifacts = readTestInfra().dotnetAgent;
const skip = needsInfra() || !artifacts;
const reason = needsInfra() ? infraSkipReason() : 'TEST_DOTNET_AGENT not set';
const stamp = Date.now().toString(36).toUpperCase();
const CAPABILITIES = [
  'CHECKIN_EVENT',
  'CHECKOUT_EVENT',
  'ROOM_MOVE_EVENT',
  'PROFILE_EVENT',
  'ROOM_STATUS_READ',
  'ROOM_STATUS_WRITE',
  'RECONCILIATION_READ',
];

describe.skipIf(skip)(
  `OPERA5_FIAS: IFC8 ↔ .NET agent ↔ gateway (${skip ? reason : 'dotnet'})`,
  () => {
    let h: GatewayHarness;
    let agent: DotnetAgent;
    let pms: SimulatedPms;
    let ifc8: Ifc8Face;
    const id = (x: string) => `OP-${x}-${stamp}`;
    const forwarded = async () => (await agent.state()).ifc8?.forwarded ?? 0;

    beforeAll(async () => {
      h = await startGatewayHarness(readTestInfra().databaseUrl!, `op-${stamp}`, {
        connectorCode: 'OPERA5_FIAS',
        capabilities: CAPABILITIES,
      });
      pms = new SimulatedPms({
        timezone: 'Africa/Cairo',
        faces: new Set(['FIAS']),
        emit: (m) => {
          if (m.message_type === 'FIAS_RECORD') ifc8.send((m.payload as { record: string }).record);
        },
      });
      ifc8 = new Ifc8Face(pms);
      const port = await ifc8.listen();
      agent = new DotnetAgent(agentBinaries(artifacts!).conformance);
      await agent.enroll(h.gatewayUrl, await h.enrollmentToken(), h.caPem);
      await agent.start('OPERA5_FIAS', CAPABILITIES, [], { ifc8: { host: '127.0.0.1', port } });
    });
    afterAll(async () => {
      await agent?.quit();
      await ifc8?.close();
      await h?.app.close();
    });

    it('links to IFC8 (link start, description, record requests, alive) and to the platform', async () => {
      await until(async () => {
        const s = await agent.state();
        return s.connected && s.ifc8?.link_up;
      });
      expect(ifc8.connected).toBe(true);
      expect(ifc8.received.some((r) => r.startsWith('LD|'))).toBe(true);
      expect(ifc8.received.filter((r) => r.startsWith('LR|')).map((r) => r.slice(5, 7))).toEqual([
        'GI',
        'GO',
        'GC',
        'RE',
        'DS',
        'DE',
      ]);
    });

    it('a stay arrives in order through an IFC8 drop and a platform link drop, exactly once', async () => {
      pms.reserve({
        id: id('1'),
        guest: { first: 'Amira', last: 'Nile', language: 'ar' },
        arrival: '2026-10-03',
        departure: '2026-10-06',
      });
      pms.checkIn(id('1'), '505', '2026-10-03T12:00:00Z');
      await until(async () => (await forwarded()) >= 1);

      // IFC8's connection breaks: OPERA keeps working, IFC8 buffers, the agent reconnects and gets the backlog.
      ifc8.drop();
      pms.move(id('1'), '506', '2026-10-04T07:00:00Z');
      pms.updateGuest(id('1'), { language: 'en' }, '2026-10-04T08:00:00Z');
      pms.roomStatus('505', 1, '2026-10-04T07:05:00Z');
      await until(async () => (await forwarded()) >= 4, 20_000);
      expect((await agent.state()).ifc8!.sessions).toBeGreaterThanOrEqual(2);

      // Then the platform link drops while the guest checks out: the record waits in the agent's queue.
      agent.dropConnection();
      pms.checkOut(id('1'), '2026-10-06T08:30:00Z');
      await until(async () => (await forwarded()) >= 5);
      await agent.drained(20_000);

      const rows = await h.messages();
      expect(rows.map((r) => r.messageType)).toEqual(Array(5).fill('FIAS_RECORD'));
      expect(rows.every((r) => r.status === 'PROCESSED')).toBe(true);
      await h.projectAll();
      const stays = await h.http().get(`${h.base}/stays`).set('X-Test-Actor', h.gm).expect(200);
      expect(stays.body).toHaveLength(1);
      const stay = await h
        .http()
        .get(`${h.base}/stays/${stays.body[0].id}`)
        .set('X-Test-Actor', h.gm)
        .expect(200);
      expect(stay.body.status).toBe('CHECKED_OUT');
      expect(
        stay.body.roomAssignments.map((a: { roomNumber: string; reason: string }) => [
          a.roomNumber,
          a.reason,
        ]),
      ).toEqual([
        ['505', 'INITIAL'],
        ['506', 'ROOM_MOVE'],
      ]);
    });

    it('reconciliation asks IFC8 for a database sync through a signed RESYNC_IN_HOUSE', async () => {
      for (const [x, room] of [
        ['A', '504'],
        ['B', '505'],
      ] as const) {
        pms.reserve({
          id: id(x),
          guest: { first: 'Sync', last: x },
          arrival: '2026-10-05',
          departure: '2026-10-07',
        });
        pms.checkIn(id(x), room);
      }
      await until(async () => (await forwarded()) >= 7);
      await agent.drained();
      await h.projectAll();

      const run = await h
        .http()
        .post(`${h.base}/integrations/${h.instanceId}/reconciliations`)
        .set('X-Test-Actor', h.gm)
        .expect(201);
      // IFC8 got DR and answered DS, one GI with the sync flag per in-house stay, DE.
      await until(async () => ifc8.received.some((r) => r.startsWith('DR|')));
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
        .get(`${h.base}/integrations/${h.instanceId}/reconciliations/${run.body.id}`)
        .set('X-Test-Actor', h.gm)
        .expect(200);
      expect(result.body).toMatchObject({
        status: 'COMPLETED',
        reportedInHouse: 2,
        summary: { MATCH: 2 },
      });
    });

    it('writes a room status to OPERA (RE with occupancy) only as a predefined signed command', async () => {
      const ask = (payload: object, key: string) =>
        h.api.requestCommand({
          tenantId: h.tenant,
          integrationInstanceId: h.instanceId,
          commandType: 'SET_ROOM_STATUS',
          payload,
          idempotencyKey: `${key}-${stamp}`,
          requestedBy: { type: 'SYSTEM', id: null },
        });
      const done = async (commandId: string) =>
        until(async () => {
          const c = await h.api.getCommand(h.tenant, commandId);
          return c && c.status !== 'PENDING' && c.status !== 'SENT' ? c : undefined;
        });
      const clean = await done(
        (await ask({ room_number: '504', status: 'CLEAN', occupied: true }, 'clean')).id,
      );
      expect(clean.status).toBe('ACKNOWLEDGED');
      expect(ifc8.received.find((r) => r.startsWith('RE|'))).toMatch(
        /^RE\|RN504\|RS4\|DA\d{6}\|TI\d{6}\|$/,
      );
      expect(pms.roomStatuses.get('504')).toBe('CLEAN');
      // FIAS status codes need the occupancy; without it the agent refuses rather than guess.
      const unknown = await done(
        (await ask({ room_number: '505', status: 'CLEAN' }, 'unknown')).id,
      );
      expect(unknown.status).toBe('FAILED');
      expect(pms.roomStatuses.has('505')).toBe(false);
    });
  },
);
