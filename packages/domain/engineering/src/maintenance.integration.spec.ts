import { sql } from 'drizzle-orm';
import { type EventEnvelope } from '@hotella/contracts-events';
import { OPERATIONS_API, type OperationsPublicApi } from '@hotella/domain-operations/public';
import { newId } from '@hotella/platform-database';
import { infraSkipReason, needsInfra, readTestInfra } from '@hotella/platform-testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MaintenanceService } from './application/maintenance.service';
import { addDays } from './domain/pm';
import { ENGINEERING_API, type EngineeringPublicApi } from './public';
import {
  createHotel,
  type EngHarness,
  type Hotel,
  staff,
  startEngineeringApp,
} from './testing/harness';

const stamp = Date.now().toString(36).toUpperCase();

interface Plan {
  id: string;
  openWorkOrderId: string | null;
  lastDoneOn: string;
  lastDoneValue: number | null;
  version: number;
}

describe.skipIf(needsInfra())(
  `Engineering meters, preventive maintenance, restrictions (${infraSkipReason()})`,
  () => {
    const url = readTestInfra().databaseUrl!;
    const gmId = newId();
    const STAFF = [
      'org.property.read',
      'org.property.manage',
      'org.location.manage',
      'org.department.manage',
      'eng.asset.read',
      'eng.asset.manage',
      'eng.config.manage',
      'eng.work_order.read',
      'eng.work_order.manage',
      'eng.pm.manage',
      'eng.restriction.manage',
      'task.read',
      'task.accept',
      'task.complete',
      'integration.read',
      'integration.configure',
    ];
    let h: EngHarness;
    let hotel: Hotel;
    let other: Hotel;
    const gm = (tenantId = hotel.tenantId) => staff(gmId, tenantId);
    const base = () => `/properties/${hotel.propertyId}/eng`;
    const today = () =>
      new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Cairo' }).format(new Date());
    const sweep = () => h.app.get(MaintenanceService).generateDue(new Date());
    const plan = async (id: string) =>
      (
        (await h.http().get(`${base()}/pm-plans`).set('X-Test-Actor', gm()).expect(200))
          .body as Plan[]
      ).find((p) => p.id === id)!;
    let chiller: { id: string };
    let runtime: { id: string };
    let temperature: { id: string };
    let procedure: { id: string; versions: Array<{ id: string; status: string }> };

    beforeAll(async () => {
      h = await startEngineeringApp(url, 'hotella_app_eng_pm', { [gmId]: STAFF });
      hotel = await createHotel(h, `engp-a-${stamp}`, gmId);
      other = await createHotel(h, `engp-b-${stamp}`, gmId, ['900']);
      await h
        .http()
        .post(`/properties/${hotel.propertyId}/departments`)
        .set('X-Test-Actor', gm())
        .send({ code: 'ENG', translations: [{ locale: 'en', name: 'Engineering' }] })
        .expect(201);
      const type = (
        await h
          .http()
          .post('/eng/asset-types')
          .set('X-Test-Actor', gm())
          .send({ code: 'CHILLER', translations: [{ locale: 'en', name: 'Chiller' }] })
          .expect(201)
      ).body as { id: string };
      chiller = (
        await h
          .http()
          .post(`${base()}/assets`)
          .set('X-Test-Actor', gm())
          .send({
            assetNumber: 'CH-01',
            assetTypeId: type.id,
            locationId: hotel.rootId,
            name: 'Chiller 1',
            criticality: 'CRITICAL',
          })
          .expect(201)
      ).body;
    });
    afterAll(() => h?.app.close());

    it('records meter readings; a cumulative meter never goes back unless replaced', async () => {
      runtime = (
        await h
          .http()
          .post(`${base()}/meters`)
          .set('X-Test-Actor', gm())
          .send({ assetId: chiller.id, kind: 'RUNTIME_HOURS', unit: 'h' })
          .expect(201)
      ).body;
      temperature = (
        await h
          .http()
          .post(`${base()}/meters`)
          .set('X-Test-Actor', gm())
          .send({ assetId: chiller.id, kind: 'TEMPERATURE', unit: '°C' })
          .expect(201)
      ).body;
      await h
        .http()
        .post(`${base()}/meters`)
        .set('X-Test-Actor', gm())
        .send({ assetId: chiller.id, kind: 'RUNTIME_HOURS', unit: 'h' })
        .expect(409);
      const read = (value: number, extra: object = {}) =>
        h
          .http()
          .post(`${base()}/meters/${runtime.id}/readings`)
          .set('X-Test-Actor', gm())
          .send({ value, ...extra });
      await read(1200).expect(201);
      const lower = await read(1100).expect(409);
      expect(lower.body.code).toBe('eng.meter.reading_lower');
      // The hour counter was replaced: it starts again.
      await read(0, { reset: true }).expect(201);
      expect((await read(600).expect(201)).body).toMatchObject({ lastValue: 600 });
      const refused = await h.db
        .execute(sql`update eng.meter_readings set value = 1 where meter_id = ${runtime.id}`)
        .then(
          () => '',
          (e: Error) => String((e.cause as Error | undefined)?.message ?? e.message),
        );
      expect(refused).toMatch(/append-only/);
    });

    it('procedures are versioned; a published version never changes', async () => {
      procedure = (
        await h
          .http()
          .post('/eng/pm-procedures')
          .set('X-Test-Actor', gm())
          .send({
            code: 'CHILLER_MONTHLY',
            title: 'Chiller monthly service',
            steps: [
              { text: 'Check refrigerant pressures', requiresReading: true },
              { text: 'Clean condenser coils' },
            ],
            estimatedMinutes: 90,
          })
          .expect(201)
      ).body;
      expect(procedure.versions).toMatchObject([{ status: 'DRAFT' }]);
      await h
        .http()
        .post(`/eng/pm-procedures/${procedure.id}/versions`)
        .set('X-Test-Actor', gm())
        .send({ steps: [{ text: 'Another draft' }] })
        .expect(409);
      await h
        .http()
        .post(`/eng/pm-procedures/versions/${procedure.versions[0]!.id}/publish`)
        .set('X-Test-Actor', gm())
        .expect(200);
      await h
        .http()
        .post(`/eng/pm-procedures/versions/${procedure.versions[0]!.id}/publish`)
        .set('X-Test-Actor', gm())
        .expect(409);
      const refused = await h.db
        .execute(
          sql`update eng.pm_procedure_versions set steps = '[]' where id = ${procedure.versions[0]!.id}`,
        )
        .then(
          () => '',
          (e: Error) => String((e.cause as Error | undefined)?.message ?? e.message),
        );
      expect(refused).toMatch(/immutable/);
      // The next version is a new draft beside it.
      const v2 = await h
        .http()
        .post(`/eng/pm-procedures/${procedure.id}/versions`)
        .set('X-Test-Actor', gm())
        .send({ steps: [{ text: 'Check refrigerant pressures' }, { text: 'Inspect vibration' }] })
        .expect(201);
      expect(v2.body).toMatchObject({ versionNo: 2, status: 'DRAFT' });
    });

    it('a calendar plan opens its preventive work once when due, pinned to the published version, and moves on when done', async () => {
      const created = (
        await h
          .http()
          .post(`${base()}/pm-plans`)
          .set('X-Test-Actor', gm())
          .send({
            assetId: chiller.id,
            procedureId: procedure.id,
            trigger: { kind: 'CALENDAR', everyDays: 30 },
            lastDoneOn: addDays(today(), -30),
          })
          .expect(201)
      ).body as Plan;
      expect(await sweep()).toBeGreaterThanOrEqual(1);
      const opened = await plan(created.id);
      expect(opened.openWorkOrderId).not.toBeNull();
      const order = (
        await h
          .http()
          .get(`${base()}/work-orders/${opened.openWorkOrderId}`)
          .set('X-Test-Actor', gm())
          .expect(200)
      ).body as {
        type: string;
        source: string;
        procedureVersionId: string;
        workItemId: string;
        codingMissing: string[];
      };
      expect(order).toMatchObject({
        type: 'PREVENTIVE',
        source: 'PM',
        procedureVersionId: procedure.versions[0]!.id,
        codingMissing: [],
      });
      const work = await h.app
        .get<OperationsPublicApi>(OPERATIONS_API)
        .getWorkItem(hotel.tenantId, order.workItemId);
      expect(work).toMatchObject({ priority: 'LOW', departmentCode: 'ENG' });
      // Due again an hour later: still one open work order.
      await sweep();
      expect((await plan(created.id)).openWorkOrderId).toBe(opened.openWorkOrderId);
      const [due] = (
        await h.db.execute(
          sql`select count(*)::int as n from platform.outbox where tenant_id = ${hotel.tenantId} and event_type = 'eng.pm.due'`,
        )
      ).rows as Array<{ n: number }>;
      expect(due!.n).toBe(1);

      await h
        .http()
        .post(`${base()}/work-orders/${opened.openWorkOrderId}/complete`)
        .set('X-Test-Actor', gm())
        .send({})
        .expect(200);
      expect(await plan(created.id)).toMatchObject({ openWorkOrderId: null, lastDoneOn: today() });
      await sweep();
      expect((await plan(created.id)).openWorkOrderId).toBeNull();
    });

    it('meter and condition plans come due from readings', async () => {
      const byMeter = (
        await h
          .http()
          .post(`${base()}/pm-plans`)
          .set('X-Test-Actor', gm())
          .send({
            assetId: chiller.id,
            procedureId: procedure.id,
            trigger: { kind: 'METER', meterId: runtime.id, everyUnits: 500 },
            lastDoneValue: 0,
          })
          .expect(201)
      ).body as Plan;
      const byCondition = (
        await h
          .http()
          .post(`${base()}/pm-plans`)
          .set('X-Test-Actor', gm())
          .send({
            assetId: chiller.id,
            procedureId: procedure.id,
            trigger: { kind: 'CONDITION', meterId: temperature.id, above: 8 },
          })
          .expect(201)
      ).body as Plan;
      // A meter of another asset cannot drive this asset's plan.
      await h
        .http()
        .post(`${base()}/pm-plans`)
        .set('X-Test-Actor', gm())
        .send({
          assetId: chiller.id,
          procedureId: procedure.id,
          trigger: { kind: 'METER', meterId: newId(), everyUnits: 500 },
        })
        .expect(404);
      const temp = (value: number) =>
        h
          .http()
          .post(`${base()}/meters/${temperature.id}/readings`)
          .set('X-Test-Actor', gm())
          .send({ value })
          .expect(201);
      await temp(7);
      await sweep();
      // 600 running hours ≥ 0 + 500: due; 7 °C is fine.
      expect((await plan(byMeter.id)).openWorkOrderId).not.toBeNull();
      expect((await plan(byCondition.id)).openWorkOrderId).toBeNull();
      await temp(9.5);
      await sweep();
      expect((await plan(byCondition.id)).openWorkOrderId).not.toBeNull();
      // Completing the meter plan's work records the value it was done at.
      await h
        .http()
        .post(`${base()}/work-orders/${(await plan(byMeter.id)).openWorkOrderId}/complete`)
        .set('X-Test-Actor', gm())
        .send({})
        .expect(200);
      expect(await plan(byMeter.id)).toMatchObject({ openWorkOrderId: null, lastDoneValue: 600 });
    });

    it('takes a room out of order, tells the PMS when it may, and keeps the history when released', async () => {
      const instance = (
        await h
          .http()
          .post(`/properties/${hotel.propertyId}/integrations`)
          .set('X-Test-Actor', gm())
          .send({ connectorCode: 'SIM_PMS', name: 'Simulator', capabilities: ['OOO_WRITE'] })
          .expect(201)
      ).body as { id: string };
      await h
        .http()
        .patch(`/properties/${hotel.propertyId}/integrations/${instance.id}`)
        .set('X-Test-Actor', gm())
        .send({ version: 1, status: 'ACTIVE' })
        .expect(200);
      const restricted = (
        await h
          .http()
          .post(`${base()}/room-restrictions`)
          .set('X-Test-Actor', gm())
          .send({ roomId: hotel.rooms['505'], kind: 'OOO', reason: 'Ceiling leak' })
          .expect(201)
      ).body as { id: string; pmsSync: string };
      expect(restricted.pmsSync).toBe('SENT');
      await h
        .http()
        .post(`${base()}/room-restrictions`)
        .set('X-Test-Actor', gm())
        .send({ roomId: hotel.rooms['505'], kind: 'OOS', reason: 'Again' })
        .expect(409);
      const api = h.app.get<EngineeringPublicApi>(ENGINEERING_API);
      expect(
        await api.activeRestriction(hotel.tenantId, hotel.propertyId, hotel.rooms['505']!),
      ).toEqual({
        id: restricted.id,
        kind: 'OOO',
      });
      expect(await api.activeRestrictions(hotel.tenantId, hotel.propertyId)).toEqual([
        { roomId: hotel.rooms['505'], kind: 'OOO', since: expect.any(String) },
      ]);
      await h
        .http()
        .post(`${base()}/room-restrictions/${restricted.id}/release`)
        .set('X-Test-Actor', gm())
        .expect(200);
      await h
        .http()
        .post(`${base()}/room-restrictions/${restricted.id}/release`)
        .set('X-Test-Actor', gm())
        .expect(409);
      expect(
        await api.activeRestriction(hotel.tenantId, hotel.propertyId, hotel.rooms['505']!),
      ).toBeNull();
      const commands = (
        await h.db.execute(
          sql`select payload from integration.integration_commands where instance_id = ${instance.id} order by created_at`,
        )
      ).rows as Array<{ payload: unknown }>;
      expect(commands.map((c) => c.payload)).toEqual([
        { room_number: '505', kind: 'OOO', active: true },
        { room_number: '505', kind: 'OOO', active: false },
      ]);
      const events = (
        (
          await h.db.execute(
            sql`select envelope from platform.outbox where tenant_id = ${hotel.tenantId} and event_type = 'eng.room_restriction.changed' order by id`,
          )
        ).rows as Array<{ envelope: EventEnvelope }>
      ).map((r) => (r.envelope.payload as { active: boolean }).active);
      expect(events).toEqual([true, false]);
      const history = (
        await h
          .http()
          .get(`${base()}/room-restrictions?open=false`)
          .set('X-Test-Actor', gm())
          .expect(200)
      ).body as Array<{ releasedAt: string | null }>;
      expect(history).toHaveLength(1);
      expect(history[0]!.releasedAt).not.toBeNull();
    });

    it('isolates tenants: another tenant’s meters, plans and restrictions are not found, and row-level security hides them', async () => {
      await h
        .http()
        .post(`/properties/${other.propertyId}/eng/meters/${runtime.id}/readings`)
        .set('X-Test-Actor', gm(other.tenantId))
        .send({ value: 9999 })
        .expect(404);
      await h
        .http()
        .post(`/properties/${other.propertyId}/eng/room-restrictions`)
        .set('X-Test-Actor', gm(other.tenantId))
        .send({ roomId: hotel.rooms['504'], kind: 'OOO', reason: 'probe' })
        .expect(404);
      const leaked = await h.db.transaction(async (tx) => {
        await tx.execute(sql`select set_config('app.tenant_id', ${other.tenantId}, true)`);
        return (
          await tx.execute(
            sql`select (select count(*)::int from eng.meters where tenant_id = ${hotel.tenantId})
            + (select count(*)::int from eng.meter_readings where tenant_id = ${hotel.tenantId})
            + (select count(*)::int from eng.pm_plans where tenant_id = ${hotel.tenantId})
            + (select count(*)::int from eng.pm_procedures where tenant_id = ${hotel.tenantId})
            + (select count(*)::int from eng.room_restrictions where tenant_id = ${hotel.tenantId}) as n`,
          )
        ).rows[0] as { n: number };
      });
      expect(leaked.n).toBe(0);
    });
  },
);
