import 'reflect-metadata';
import type { INestApplication } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { integrationSchema, PMS_API, type PmsPublicApi } from '@hotella/domain-integrations';
import type { Database } from '@hotella/platform-database';
import { eventsSchema } from '@hotella/platform-events';
import { infraSkipReason, needsInfra, readTestInfra } from '@hotella/platform-testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AgentLinkClient, answerQuery, DurableQueue, enroll, SimulatedPms } from '../src';
import { CAPABILITIES, type GatewayHarness, startGatewayHarness, until } from './gateway-harness';

const stamp = Date.now().toString(36).toUpperCase();
const READS = [
  'RESERVATION_LOOKUP',
  'ARRIVALS_READ',
  'IN_HOUSE_SNAPSHOT',
  'PROFILE_LOOKUP',
  'ROOM_INVENTORY_READ',
];

describe.skipIf(needsInfra())(
  `link protocol 2: PMS_API reads answered by the agent over mutual TLS (${infraSkipReason()})`,
  () => {
    let h: GatewayHarness;
    let app: INestApplication;
    let db: Database;
    let pms: SimulatedPms;
    let client: AgentLinkClient;
    let api: PmsPublicApi;
    const ctx = () => ({
      tenantId: h.tenant,
      propertyId: h.property,
      requestedBy: { type: 'USER', id: null },
      deadlineMs: 5_000,
    });
    const queries = () =>
      db
        .select()
        .from(integrationSchema.integrationQueries)
        .where(eq(integrationSchema.integrationQueries.instanceId, h.instanceId));

    beforeAll(async () => {
      h = await startGatewayHarness(readTestInfra().databaseUrl!, `q-${stamp}`, {
        connectorCode: 'SIM_PMS',
        capabilities: [...CAPABILITIES, ...READS],
      });
      ({ app, db } = h);
      api = app.get(PMS_API);
      const identity = await enroll({
        gatewayUrl: h.gatewayUrl,
        token: await h.enrollmentToken(),
        caCertificatePem: h.caPem,
        agentVersion: 'test',
      });
      pms = new SimulatedPms({
        timezone: 'Africa/Cairo',
        faces: new Set(['FIAS', 'OWS']),
        emit: (m) => client.publish(m),
      });
      client = new AgentLinkClient({
        gatewayUrl: h.gatewayUrl,
        identity,
        queue: DurableQueue.memory(),
        connectorCode: 'SIM_PMS',
        capabilities: [...CAPABILITIES, ...READS],
        agentVersion: 'test',
        onQuery: async (q) => answerQuery(pms, q.query_type, q.params),
        onCommand: async () => ({ status: 'FAILED', error: 'not in this test' }),
      });
      for (const [id, room, last] of [
        ['Q-A', '504', 'Nour'],
        ['Q-B', '505', 'Hassan'],
      ] as const) {
        pms.reserve({
          id: `${id}-${stamp}`,
          guest: { profileId: `P-${id}`, first: 'Guest', last, email: `${id}@guest.example` },
          arrival: '2026-10-05',
          departure: '2026-10-08',
        });
        pms.checkIn(`${id}-${stamp}`, room);
      }
      pms.reserve({
        id: `Q-C-${stamp}`,
        guest: { profileId: 'P-Q-C', first: 'Future' },
        arrival: '2026-10-20',
        departure: '2026-10-22',
      });
      client.start();
      await until(async () => client.connected);
      await client.drained();
    });
    afterAll(async () => {
      client?.stop();
      await app?.close();
    });

    it('answers lookups, lists and the room inventory through the agent, validated against the manifest', async () => {
      const found = await api.lookupReservation({ ...ctx(), reservationId: `Q-A-${stamp}` });
      expect(found).toMatchObject({
        outcome: 'OK',
        connectorCode: 'SIM_PMS',
        rows: [{ reservation_id: `Q-A-${stamp}`, status: 'IN_HOUSE', room_number: '504' }],
      });
      const arrivals = await api.listArrivals({ ...ctx(), from: '2026-10-19', to: '2026-10-21' });
      expect(arrivals.outcome === 'OK' && arrivals.rows.map((r) => r.reservation_id)).toEqual([
        `Q-C-${stamp}`,
      ]);
      const inHouse = await api.inHouseSnapshot(ctx());
      expect(inHouse.outcome === 'OK' && inHouse.rows.map((r) => r.room_number).sort()).toEqual([
        '504',
        '505',
      ]);
      const profile = await api.lookupProfile({ ...ctx(), profileId: 'P-Q-B' });
      expect(profile).toMatchObject({
        outcome: 'OK',
        rows: [{ profile_id: 'P-Q-B', last_name: 'Hassan', email: 'Q-B@guest.example' }],
      });
      const rooms = await api.roomInventory(ctx());
      expect(rooms.outcome === 'OK' && rooms.rows.map((r) => r.room_number)).toEqual([
        '504',
        '505',
      ]);
    });

    it('keeps a request log, never the answers once taken', async () => {
      const log = await queries();
      expect(log.length).toBeGreaterThanOrEqual(5);
      expect(log.every((q) => q.status === 'ANSWERED' && q.result === null)).toBe(true);
      expect(log.find((q) => q.queryType === 'IN_HOUSE')).toMatchObject({
        rowCount: 2,
        routing: { operation: 'IN_HOUSE_SNAPSHOT', chosen: 'SIM_PMS' },
      });
    });

    it('refuses invalid parameters before asking the agent', async () => {
      await expect(
        api.listArrivals({ ...ctx(), from: '2026-10-01', to: '2026-12-31' }),
      ).rejects.toMatchObject({ code: 'integration.query.invalid_params' });
    });

    it('reconciles from the in-house snapshot read instead of interrupting IFC8', async () => {
      const run = await h
        .http()
        .post(`${h.base}/integrations/${h.instanceId}/reconciliations`)
        .set('X-Test-Actor', h.gm)
        .expect(201);
      expect(run.body).toMatchObject({ commandId: null });
      expect(run.body.snapshotCompletedAt).not.toBeNull();
      const entries = await db
        .select()
        .from(integrationSchema.reconciliationEntries)
        .where(eq(integrationSchema.reconciliationEntries.runId, run.body.id));
      expect(entries.map((e) => e.roomCode).sort()).toEqual(['504', '505']);
      expect(entries.every((e) => e.roomId)).toBe(true);
      const completed = await db
        .select()
        .from(eventsSchema.outbox)
        .where(
          and(
            eq(eventsSchema.outbox.aggregateId, run.body.id),
            eq(eventsSchema.outbox.eventType, 'integration.reconciliation.snapshot_completed'),
          ),
        );
      expect(completed).toHaveLength(1);
    });

    it('falls through to UNAVAILABLE/FAILED honestly when the agent is gone', async () => {
      client.stop();
      await until(async () => {
        const status = await h
          .http()
          .get(`${h.base}/integrations/${h.instanceId}/agent`)
          .set('X-Test-Actor', h.gm)
          .expect(200);
        return status.body.connected === false;
      });
      const gone = await api.inHouseSnapshot(ctx());
      expect(gone).toEqual({
        outcome: 'FAILED',
        capability: 'IN_HOUSE_SNAPSHOT',
        attempts: [{ connectorCode: 'SIM_PMS', status: 'UNREACHABLE' }],
      });
    });
  },
);
