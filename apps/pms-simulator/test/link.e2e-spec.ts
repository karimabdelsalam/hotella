import 'reflect-metadata';
import type { INestApplication } from '@nestjs/common';
import { join } from 'node:path';
import { and, asc, eq, like, sql } from 'drizzle-orm';
import { WebSocket } from 'ws';
import type { EventEnvelope } from '@hotella/contracts-events';
import { projectOnce, reconcileOnce, StayProjector, StayReconciler } from '@hotella/domain-guest';
import {
  AgentLinkService,
  integrationSchema,
  type IntegrationsPublicApi,
} from '@hotella/domain-integrations';
import type { Database } from '@hotella/platform-database';
import { eventsSchema, IdempotentConsumer } from '@hotella/platform-events';
import { infraSkipReason, needsInfra, readTestInfra } from '@hotella/platform-testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type AgentIdentity,
  AgentLinkClient,
  DurableQueue,
  enroll,
  type HttpError,
  loadScenario,
  runScenario,
  SimulatedPms,
} from '../src';
import { CAPABILITIES, type GatewayHarness, startGatewayHarness, until } from './gateway-harness';

const stamp = Date.now().toString(36).toUpperCase();

/** The connector entitlement the fake licensing context reports (null: open-ended; undefined: not entitled). */
const ENTITLED: { until: Date | null | undefined; asked: string[] } = { until: null, asked: [] };
const entitlements = {
  can: async () => ENTITLED.until !== undefined,
  entitledUntil: async (_t: string, _p: string | null, code: string) => {
    ENTITLED.asked.push(code);
    return ENTITLED.until;
  },
  effective: async () => [],
  assertWithinLimit: async () => undefined,
};

describe.skipIf(needsInfra())(
  `hotel agent link: simulator ↔ gateway over mutual TLS (${infraSkipReason()})`,
  () => {
    let h: GatewayHarness;
    let app: INestApplication;
    let db: Database;
    let api: IntegrationsPublicApi;
    let gatewayUrl: string;
    let caPem: string;
    let tenant: string;
    let instanceId: string;
    let identity: AgentIdentity;
    let client: AgentLinkClient;
    let pms: SimulatedPms;
    const queue = DurableQueue.memory();
    const http = () => h.http();
    const gm = () => h.gm;
    const base = () => h.base;
    const messages = () => h.messages();

    beforeAll(async () => {
      h = await startGatewayHarness(readTestInfra().databaseUrl!, `sim-${stamp}`, undefined, {
        entitlements,
      });
      ({ app, db, api, gatewayUrl, caPem, tenant, instanceId } = h);
    });
    afterAll(async () => {
      client?.stop();
      await app?.close();
    });

    it('enrolls once with a single-use token and gets a device certificate', async () => {
      const token = await h.enrollmentToken();
      identity = await enroll({ gatewayUrl, token, caCertificatePem: caPem, agentVersion: 'test' });
      expect(identity.instanceId).toBe(instanceId);
      await expect(
        enroll({ gatewayUrl, token, caCertificatePem: caPem, agentVersion: 'test' }),
      ).rejects.toMatchObject({ status: 401, code: 'integration.agent.enrollment_invalid' });
      const status = await http()
        .get(`${base()}/integrations/${instanceId}/agent`)
        .set('X-Test-Actor', gm())
        .expect(200);
      expect(status.body).toMatchObject({ enrolled: true, connected: false });
    });

    it('rejects a link without a client certificate', async () => {
      const ws = new WebSocket(`${gatewayUrl.replace('https', 'wss')}/agent/v1/link`, {
        ca: caPem,
      });
      const status = await new Promise<number>((resolve) => {
        ws.on('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0));
        ws.on('error', () => resolve(-1));
      });
      expect(status).toBe(401);
    });

    it('connects, reports capabilities and delivers a scenario exactly once despite chaos', async () => {
      client = new AgentLinkClient({
        gatewayUrl,
        identity,
        queue,
        connectorCode: 'SIM_PMS',
        capabilities: CAPABILITIES.filter((c) => c !== 'GUEST_READ'),
        agentVersion: 'test',
        onCommand: async (cmd) =>
          cmd.command_type === 'RESYNC_IN_HOUSE'
            ? (pms.resyncInHouse(), { status: 'ACKNOWLEDGED' as const })
            : { status: 'FAILED' as const, error: 'unsupported' },
      });
      const scenario = loadScenario(join(process.cwd(), 'scenarios', 'basic-stay.yml'));
      pms = new SimulatedPms({
        timezone: scenario.timezone,
        faces: new Set(scenario.faces),
        emit: (m) => client.publish(m),
      });
      client.start();
      await until(async () => client.connected);
      const instance = await http()
        .get(`${base()}/integrations/${instanceId}`)
        .set('X-Test-Actor', gm())
        .expect(200);
      // A licence came with the welcome, signed by the platform for this instance.
      expect(client.licence).toMatchObject({
        typ: 'hotella.licence.v1',
        instance_id: instanceId,
        connector_code: 'SIM_PMS',
        grace_days: 14,
      });
      // Enabled ∩ reported: the agent did not report GUEST_READ, so it is not effective.
      expect(instance.body.effectiveCapabilities).not.toContain('GUEST_READ');
      expect(instance.body.effectiveCapabilities).toContain('CHECKIN_EVENT');

      await runScenario(scenario, pms, client);
      expect(client.stats.resends).toBeGreaterThanOrEqual(1);
      expect(client.stats.connects).toBeGreaterThanOrEqual(2);

      const rows = await messages();
      const sequences = rows.map((m) => m.sequenceNo).sort((a, b) => a! - b!);
      expect(new Set(sequences).size).toBe(rows.length);
      expect(sequences).toEqual(sequences.map((_, i) => i + 1));
      // The OWS profile message needs GUEST_READ, which this hotel's agent does not serve.
      expect(rows.filter((m) => m.status !== 'PROCESSED').map((m) => m.messageType)).toEqual(
        rows.filter((m) => m.messageType === 'OWS_PROFILE').map(() => 'OWS_PROFILE'),
      );

      // Project the canonical events like the worker does, then read the stay.
      const project = projectOnce(app.get(IdempotentConsumer), app.get(StayProjector));
      const outbox = await db
        .select()
        .from(eventsSchema.outbox)
        .where(
          and(
            eq(eventsSchema.outbox.tenantId, tenant),
            like(eventsSchema.outbox.eventType, 'hotel.%'),
          ),
        )
        .orderBy(asc(eventsSchema.outbox.createdAt), asc(eventsSchema.outbox.id));
      for (const r of outbox) await project(r.envelope as EventEnvelope);
      const stays = await http().get(`${base()}/stays`).set('X-Test-Actor', gm()).expect(200);
      expect(stays.body).toHaveLength(1);
      const stay = await http()
        .get(`${base()}/stays/${stays.body[0].id}`)
        .set('X-Test-Actor', gm())
        .expect(200);
      expect(stay.body.status).toBe('CHECKED_OUT');
      expect(
        stay.body.roomAssignments.map((a: { roomNumber: string; reason: string }) => [
          a.roomNumber,
          a.reason,
        ]),
      ).toEqual([
        ['504', 'PRE_ASSIGNMENT'],
        ['505', 'INITIAL'],
        ['506', 'ROOM_MOVE'],
      ]);
      expect(
        stay.body.party.find((m: { role: string }) => m.role === 'PRIMARY').guest.primaryLocale,
      ).toBe('en');

      // A message held back for the reorder chaos is not stranded when nothing follows it (pilot defect).
      client.chaos.reorderNext = true;
      pms.roomStatus('504', 1, '2026-10-06T09:00:00Z');
      await client.drained(5_000);
    });

    it('heartbeats report liveness and backlog; rejected messages degrade health', async () => {
      const health = await until(async () => {
        const h = await http()
          .get(`${base()}/integrations/${instanceId}`)
          .set('X-Test-Actor', gm())
          .expect(200);
        // The hello marks the agent seen; the first heartbeat (every 5 s here) adds its backlog.
        return h.body.health?.queueDepth !== null ? h.body.health : undefined;
      });
      // Alive, but the rejected OWS profile message (capability not served by this agent) counts as an error.
      expect(health.queueDepth).toBe(0);
      expect(health.errorRatePermille).toBeGreaterThan(0);
      expect(health.status).toBe('DEGRADED');
    });

    it('delivers signed commands and records the agent result', async () => {
      const command = await api.requestCommand({
        tenantId: tenant,
        integrationInstanceId: instanceId,
        commandType: 'RESYNC_IN_HOUSE',
        payload: {},
        idempotencyKey: `resync-${stamp}`,
        requestedBy: { type: 'SYSTEM', id: null },
      });
      const again = await api.requestCommand({
        tenantId: tenant,
        integrationInstanceId: instanceId,
        commandType: 'RESYNC_IN_HOUSE',
        payload: {},
        idempotencyKey: `resync-${stamp}`,
        requestedBy: { type: 'SYSTEM', id: null },
      });
      expect(again.id).toBe(command.id);
      const done = await until(async () => {
        const c = await api.getCommand(tenant, command.id);
        return c?.status === 'ACKNOWLEDGED' ? c : undefined;
      });
      expect(done.attempts).toBe(1);
      expect(client.stats.commands).toBe(1);
      expect(client.stats.rejectedCommands).toBe(0);
      await expect(
        api.requestCommand({
          tenantId: tenant,
          integrationInstanceId: instanceId,
          commandType: 'OPEN_SHELL',
          payload: {},
          idempotencyKey: `x-${stamp}`,
          requestedBy: { type: 'SYSTEM', id: null },
        }),
      ).rejects.toMatchObject({ code: 'integration.command.unknown' });
    });

    it('reconciles the PMS in-house list with the platform: MATCH and every discrepancy', async () => {
      const project = projectOnce(app.get(IdempotentConsumer), app.get(StayProjector));
      const reconcile = reconcileOnce(app.get(IdempotentConsumer), app.get(StayReconciler));
      const projectAll = async () => {
        const rows = await db
          .select()
          .from(eventsSchema.outbox)
          .where(
            and(
              eq(eventsSchema.outbox.tenantId, tenant),
              like(eventsSchema.outbox.eventType, 'hotel.%'),
            ),
          )
          .orderBy(asc(eventsSchema.outbox.createdAt), asc(eventsSchema.outbox.id));
        for (const r of rows) await project(r.envelope as EventEnvelope);
      };
      const id = (x: string) => `REC-${x}-${stamp}`;
      for (const [x, room] of [
        ['A', '504'],
        ['B', '505'],
        ['C', '506'],
      ] as const) {
        pms.reserve({
          id: id(x),
          guest: { first: 'Rec', last: x },
          arrival: '2026-10-05',
          departure: '2026-10-07',
        });
        pms.checkIn(id(x), room);
      }
      await client.drained();
      await projectAll();
      // Discrepancies that exist only in the PMS (nothing was sent): B moved, C left, D unknown to the platform.
      pms.reservations.get(id('B'))!.room = '506';
      pms.reservations.get(id('C'))!.status = 'CHECKED_OUT';
      pms.reservations.set(id('D'), {
        id: id('D'),
        confirmation: 'D',
        guest: { first: 'Rec', last: 'D' },
        sharers: [],
        arrival: '2026-10-05',
        departure: '2026-10-06',
        adults: 1,
        children: 0,
        room: '504',
        status: 'IN_HOUSE',
      });

      const run = await http()
        .post(`${base()}/integrations/${instanceId}/reconciliations`)
        .set('X-Test-Actor', gm())
        .expect(201);
      const snapshot = await until(async () => {
        const rows = await db
          .select()
          .from(eventsSchema.outbox)
          .where(
            and(
              eq(eventsSchema.outbox.aggregateId, run.body.id),
              eq(eventsSchema.outbox.eventType, 'integration.reconciliation.snapshot_completed'),
            ),
          );
        return rows[0];
      });
      expect(await reconcile(snapshot.envelope as EventEnvelope)).toBe('processed');
      expect(await reconcile(snapshot.envelope as EventEnvelope)).toBe('duplicate');

      const result = await http()
        .get(`${base()}/integrations/${instanceId}/reconciliations/${run.body.id}`)
        .set('X-Test-Actor', gm())
        .expect(200);
      expect(result.body).toMatchObject({
        status: 'COMPLETED',
        reportedInHouse: 3,
        summary: { MATCH: 1, DIFFERENT: 1, MISSING_INTERNAL: 1, MISSING_EXTERNAL: 1 },
      });
      const byOutcome = Object.fromEntries(
        (
          result.body.results as Array<{ outcome: string; externalId: string; details: object }>
        ).map((r) => [r.outcome, r]),
      );
      expect(byOutcome['MATCH']?.externalId).toBe(id('A'));
      expect(byOutcome['DIFFERENT']).toMatchObject({
        externalId: id('B'),
        details: { field: 'room' },
      });
      expect(byOutcome['MISSING_INTERNAL']?.externalId).toBe(id('D'));
      expect(byOutcome['MISSING_EXTERNAL']?.externalId).toBe(id('C'));
      // Differences are a human's job: three exceptions, and no stay was changed by the reconciliation.
      const exceptions = await http()
        .get(`${base()}/integration-exceptions?status=OPEN`)
        .set('X-Test-Actor', gm())
        .expect(200);
      expect(
        (exceptions.body as Array<{ detail: { reason?: string } }>).filter(
          (e) => e.detail.reason === 'reconciliation',
        ),
      ).toHaveLength(3);
      const stays = await http()
        .get(`${base()}/stays?status=IN_HOUSE`)
        .set('X-Test-Actor', gm())
        .expect(200);
      expect(stays.body).toHaveLength(3);
    });

    it('accepts HTTPS batches for large resyncs, in order and idempotently', async () => {
      client.stop();
      await until(async () => !client.connected);
      pms.reserve({
        id: `B-${stamp}`,
        guest: { first: 'Batch' },
        arrival: '2026-11-01',
        departure: '2026-11-02',
      });
      pms.reserve({
        id: `B2-${stamp}`,
        guest: { first: 'Batch2' },
        arrival: '2026-11-03',
        departure: '2026-11-04',
      });
      expect(queue.depth).toBe(2);
      const before = (await messages()).length;
      const res = await client.sendBatch();
      expect(res.resend_from).toBeNull();
      expect(queue.depth).toBe(0);
      expect((await messages()).length).toBe(before + 2);
    });

    it('issues the agent licence only while the tenant is entitled to the connector (Spec §62)', async () => {
      const link = app.get(AgentLinkService) as unknown as {
        licence(instance: unknown): Promise<{ expires_at: string } | undefined>;
      };
      const [instance] = await db
        .select()
        .from(integrationSchema.integrationInstances)
        .where(eq(integrationSchema.integrationInstances.id, instanceId));
      ENTITLED.until = null;
      const open = await link.licence(instance);
      expect(ENTITLED.asked.at(-1)).toBe('CONNECTOR_PMS');
      expect(new Date(open!.expires_at).getTime()).toBeGreaterThan(Date.now() + 29 * 86_400_000);
      // A subscription ending in five days: the licence ends with it, not 30 days out.
      const ends = new Date(Date.now() + 5 * 86_400_000);
      ENTITLED.until = ends;
      expect((await link.licence(instance))!.expires_at).toBe(ends.toISOString());
      // Not entitled: no licence at all (the agent buffers and, past its grace, refuses commands).
      ENTITLED.until = undefined;
      expect(await link.licence(instance)).toBeUndefined();
      ENTITLED.until = null;
    });

    it('revocation closes the link at once and the certificate stops working', async () => {
      client.start();
      await until(async () => client.connected);
      await http()
        .post(`${base()}/integrations/${instanceId}/agent/revoke`)
        .set('X-Test-Actor', gm())
        .send({ reason: 'decommissioned test agent' })
        .expect(200);
      await until(async () => client.revoked, 10_000);
      expect(client.connected).toBe(false);
      await expect(client.sendBatch().catch((e: HttpError) => e.status)).resolves.toBe(401);
      const audit = await db.execute<{ action: string }>(
        sql`select action from audit.audit_log where entity_id = ${instanceId} order by occurred_at`,
      );
      expect(audit.rows.map((r) => r.action)).toEqual(
        expect.arrayContaining([
          'integration.agent.enrollment_token.create',
          'integration.agent.enroll',
          'integration.agent.revoke',
        ]),
      );
    });
  },
);
