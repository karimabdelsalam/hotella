import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { integrationSchema, PMS_API, type PmsPublicApi } from '@hotella/domain-integrations';
import {
  infraSkipReason,
  needsDotnetAgent,
  needsInfra,
  readTestInfra,
} from '@hotella/platform-testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseFixture, SimulatedPms } from '../src';
import { agentBinaries, DotnetAgent } from './dotnet-agent';
import { type GatewayHarness, startGatewayHarness, until } from './gateway-harness';

/**
 * OPERA 5 read-only database (BUILD_PLAN 10.7, ADR-0019): the .NET agent answers the platform's predefined reads over
 * link protocol 2 with data contract v1 statements — here against the simulator's OPERA-shaped fixture, since CI does
 * not run Oracle. PMS_API lookups, lists and the room inventory, reconciliation from the in-house snapshot, fallback
 * change polling, and the refusal of every read once the account can write. Skipped without a built agent.
 */
const artifacts = readTestInfra().dotnetAgent;
const skip = needsDotnetAgent();
const reason = needsInfra() ? infraSkipReason() : 'TEST_DOTNET_AGENT not set';
const stamp = Date.now().toString(36).toUpperCase();
const CAPABILITIES = [
  'RESERVATION_READ',
  'RESERVATION_LOOKUP',
  'ARRIVALS_READ',
  'IN_HOUSE_SNAPSHOT',
  'GUEST_READ',
  'PROFILE_LOOKUP',
  'ROOM_INVENTORY_READ',
  'RECONCILIATION_READ',
];
const inDays = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);

describe.skipIf(skip)(
  `OPERA5_DB: data contract v1 reads ↔ .NET agent ↔ gateway (${skip ? reason : 'dotnet'})`,
  () => {
    let h: GatewayHarness;
    let agent: DotnetAgent;
    let pms: SimulatedPms;
    let api: PmsPublicApi;
    const dir = mkdtempSync(join(tmpdir(), 'opera-db-'));
    const fixture = join(dir, 'opera.json');
    const id = (x: string) => `DB-${x}-${stamp}`;
    const save = (privileges?: Parameters<typeof databaseFixture>[2]) =>
      writeFileSync(fixture, JSON.stringify(databaseFixture(pms, 'SIM', privileges)));
    const ctx = () => ({
      tenantId: h.tenant,
      propertyId: h.property,
      requestedBy: { type: 'USER', id: null },
      deadlineMs: 10_000,
    });

    beforeAll(async () => {
      h = await startGatewayHarness(readTestInfra().databaseUrl!, `db-${stamp}`, {
        connectorCode: 'OPERA5_DB',
        capabilities: CAPABILITIES,
      });
      api = h.app.get(PMS_API);
      pms = new SimulatedPms({ timezone: 'Africa/Cairo', faces: new Set(), emit: () => undefined });
      for (const [x, room, last] of [
        ['A', '504', 'Nour'],
        ['B', '505', 'Adel'],
      ] as const) {
        pms.reserve({
          id: id(x),
          guest: {
            profileId: `P-${x}-${stamp}`,
            first: 'Guest',
            last,
            email: `${x}@guest.example`,
          },
          arrival: inDays(0),
          departure: inDays(3),
        });
        pms.checkIn(id(x), room);
      }
      pms.reserve({
        id: id('C'),
        guest: { profileId: `P-C-${stamp}`, first: 'Future', last: 'Guest' },
        arrival: inDays(5),
        departure: inDays(7),
      });
      save();
      agent = new DotnetAgent(agentBinaries(artifacts).conformance);
      await agent.enroll(h.gatewayUrl, await h.enrollmentToken(), h.caPem);
      await agent.start('OPERA5_DB', CAPABILITIES, [], {
        opera_db: { fixture, resort: 'SIM' },
      });
      await until(async () => (await agent.state()).connected);
    });
    afterAll(async () => {
      await agent?.quit();
      await h?.app.close();
      rmSync(dir, { recursive: true, force: true });
    });

    it('answers lookups, arrivals, the in-house list, profiles and rooms through PMS_API', async () => {
      expect(await agent.state()).toMatchObject({ opera_db: { up: true, problem: null } });
      const found = await api.lookupReservation({ ...ctx(), confirmationNumber: `C${id('A')}` });
      expect(found).toMatchObject({
        outcome: 'OK',
        connectorCode: 'OPERA5_DB',
        rows: [{ reservation_id: id('A'), status: 'IN_HOUSE', room_number: '504' }],
      });
      const arrivals = await api.listArrivals({ ...ctx(), from: inDays(4), to: inDays(6) });
      expect(arrivals.outcome === 'OK' && arrivals.rows.map((r) => r.reservation_id)).toEqual([
        id('C'),
      ]);
      const inHouse = await api.inHouseSnapshot(ctx());
      expect(inHouse.outcome === 'OK' && inHouse.rows.map((r) => r.room_number).sort()).toEqual([
        '504',
        '505',
      ]);
      const profile = await api.lookupProfile({ ...ctx(), profileId: `P-B-${stamp}` });
      expect(profile).toMatchObject({
        outcome: 'OK',
        rows: [{ last_name: 'Adel', email: 'B@guest.example' }],
      });
      const rooms = await api.roomInventory(ctx());
      expect(rooms.outcome === 'OK' && rooms.rows.map((r) => r.room_number)).toEqual([
        '504',
        '505',
      ]);
      expect((await agent.state()).stats).toMatchObject({ queries: 5, rejected_queries: 0 });
    });

    it('reconciles from the database snapshot (no IFC8 database swap)', async () => {
      const run = await h
        .http()
        .post(`${h.base}/integrations/${h.instanceId}/reconciliations`)
        .set('X-Test-Actor', h.gm)
        .expect(201);
      expect(run.body).toMatchObject({ commandId: null });
      const entries = await h.db
        .select()
        .from(integrationSchema.reconciliationEntries)
        .where(eq(integrationSchema.reconciliationEntries.runId, run.body.id));
      expect(entries.map((e) => e.externalId).sort()).toEqual([id('A'), id('B')]);
    });

    it('fallback change polling forwards the arrival window once, as OPERA_DB_RESERVATION messages', async () => {
      expect(await agent.operaDbPoll()).toBe(3);
      expect(await agent.operaDbPoll()).toBe(0);
      const messages = await until(async () => {
        const rows = (await h.messages()).filter((m) => m.messageType === 'OPERA_DB_RESERVATION');
        return rows.length === 3 && rows.every((m) => m.status === 'PROCESSED') && rows;
      });
      expect(messages).toHaveLength(3);
    });

    it('refuses every read once the account can write, and says why', async () => {
      save({
        system: ['CREATE SESSION'],
        tables: [
          { owner: 'OPERA', table: 'RESERVATION_NAME', privilege: 'SELECT' },
          { owner: 'OPERA', table: 'RESERVATION_NAME', privilege: 'UPDATE' },
        ],
        roles: [],
      });
      expect(await agent.operaDbCheck()).toEqual([
        'UPDATE on OPERA.RESERVATION_NAME is not allowed',
      ]);
      expect((await agent.state()).opera_db).toMatchObject({ up: false });
      const refused = await api.inHouseSnapshot(ctx());
      expect(refused).toEqual({
        outcome: 'FAILED',
        capability: 'IN_HOUSE_SNAPSHOT',
        attempts: [{ connectorCode: 'OPERA5_DB', status: 'FAILED' }],
      });
      const [last] = (
        await h.db
          .select()
          .from(integrationSchema.integrationQueries)
          .where(eq(integrationSchema.integrationQueries.instanceId, h.instanceId))
      ).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
      expect(last!.error).toContain('more than read access');
    });
  },
);
