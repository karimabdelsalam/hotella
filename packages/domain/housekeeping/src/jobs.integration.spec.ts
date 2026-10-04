import { sql } from 'drizzle-orm';
import { createEnvelope, type EventEnvelope, GuestCheckedOut } from '@hotella/contracts-events';
import type { InspectionSummary } from '@hotella/domain-inspection/public';
import { OPERATIONS_API, type OperationsPublicApi } from '@hotella/domain-operations/public';
import { newId } from '@hotella/platform-database';
import { infraSkipReason, needsInfra, readTestInfra } from '@hotella/platform-testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { JobService } from './application/job.service';
import {
  CHECKLISTS,
  createHotel,
  type HkHarness,
  type Hotel,
  staff,
  startHousekeepingApp,
} from './testing/harness';

const stamp = Date.now().toString(36).toUpperCase();

interface JobView {
  id: string;
  roomId: string;
  roomNumber: string | null;
  workItemId: string;
  cleaningType: string;
  origin: string;
  credits: number;
  status: string;
  scheduledFor: string;
  taskId: string | null;
  priority: string | null;
  skipReason: string | null;
}

describe.skipIf(needsInfra())(`Housekeeping cleaning jobs (${infraSkipReason()})`, () => {
  const url = readTestInfra().databaseUrl!;
  const gmId = newId();
  const STAFF = [
    'org.property.read',
    'org.property.manage',
    'org.location.manage',
    'org.department.manage',
    'hk.board.read',
    'hk.room.manage',
    'hk.job.manage',
    'hk.inspect',
    'hk.config.manage',
    'task.read',
    'task.accept',
    'task.complete',
    'config.read',
    'config.manage',
    'integration.read',
    'integration.configure',
  ];
  let h: HkHarness;
  let hotel: Hotel;
  let other: Hotel;
  const gm = (tenantId = hotel.tenantId) => staff(gmId, tenantId);
  const base = () => `/properties/${hotel.propertyId}`;
  const room = (n: string) => hotel.rooms[n]!;
  const scope = () => ({ tenantId: hotel.tenantId, propertyId: hotel.propertyId });
  const jobs = () => h.app.get(JobService);
  /** Today in the hotel's time zone (Cairo), the day jobs are filed under. */
  const today = () =>
    new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Cairo' }).format(new Date());
  const list = async (query = '') =>
    (
      await h
        .http()
        .get(`${base()}/housekeeping/jobs${query}`)
        .set('X-Test-Actor', gm())
        .expect(200)
    ).body as JobView[];
  const housekeeping = async (n: string) => {
    const rows = (
      await h.http().get(`${base()}/housekeeping/rooms`).set('X-Test-Actor', gm()).expect(200)
    ).body as Array<{ roomNumber: string; housekeeping: string | null }>;
    return rows.find((r) => r.roomNumber === n)!.housekeeping;
  };
  /** Staff move the job's task; the worker would then deliver the work item's status change. */
  const work = async (job: JobView, ...actions: Array<'accept' | 'start' | 'complete'>) => {
    for (const action of actions)
      await h
        .http()
        .post(`${base()}/tasks/${job.taskId}/${action}`)
        .set('X-Test-Actor', gm())
        .send({})
        .expect(200);
    await jobs().follow(scope(), job.workItemId);
  };
  const checkout = (roomNumber: string, at: Date): EventEnvelope =>
    createEnvelope(GuestCheckedOut, {
      eventId: newId(),
      tenantId: hotel.tenantId,
      propertyId: hotel.propertyId,
      source: 'integration',
      correlationId: `hk-jobs-${stamp}`,
      occurredAt: at,
      payload: {
        reservation: {
          integration_instance_id: newId(),
          external_id: `R-${stamp}-${roomNumber}`,
          confirmation_number: null,
        },
        room: { room_id: room(roomNumber), room_number: roomNumber },
        checked_out_at: at.toISOString(),
      },
    } as never) as EventEnvelope;
  const setting = (key: string, value: unknown) =>
    h
      .http()
      .put(`/config/values/${key}`)
      .set('X-Test-Actor', gm())
      .send({ scope: 'PROPERTY', tenantId: hotel.tenantId, propertyId: hotel.propertyId, value })
      .expect(200);

  beforeAll(async () => {
    h = await startHousekeepingApp(url, 'hotella_app_hk_jobs', { [gmId]: STAFF });
    hotel = await createHotel(h, `hkj-a-${stamp}`, gmId);
    other = await createHotel(h, `hkj-b-${stamp}`, gmId, ['900']);
  });
  afterAll(() => h?.app.close());

  it('a check-out creates one CHECKOUT clean for Housekeeping, at the default credits, once', async () => {
    const at = new Date();
    const event = checkout('101', at);
    await jobs().apply(event);
    // The same event delivered again, or the same check-out reported twice, adds nothing.
    await jobs().apply(event);
    await jobs().apply(checkout('101', at));
    const [job, ...rest] = await list();
    expect(rest).toEqual([]);
    expect(job).toMatchObject({
      roomNumber: '101',
      cleaningType: 'CHECKOUT',
      origin: 'GENERATED',
      credits: 1,
      status: 'OPEN',
      scheduledFor: today(),
      priority: 'NORMAL',
    });
    const item = await h.app
      .get<OperationsPublicApi>(OPERATIONS_API)
      .getWorkItem(hotel.tenantId, job!.workItemId);
    expect(item).toMatchObject({ kind: 'HK_JOB', departmentCode: 'HK', locationId: room('101') });
    const [created] = (
      await h.db.execute(
        sql`select count(*)::int as n from platform.outbox where tenant_id = ${hotel.tenantId} and event_type = 'hk.job.created'`,
      )
    ).rows as Array<{ n: number }>;
    expect(created!.n).toBe(1);
  });

  it('the job follows its work: started cleans the room, finished makes it clean, and the PMS is told', async () => {
    // An active PMS integration that may write room statuses.
    const instance = (
      await h
        .http()
        .post(`${base()}/integrations`)
        .set('X-Test-Actor', gm())
        .send({ connectorCode: 'SIM_PMS', name: 'Simulator', capabilities: ['ROOM_STATUS_WRITE'] })
        .expect(201)
    ).body as { id: string };
    await h
      .http()
      .patch(`${base()}/integrations/${instance.id}`)
      .set('X-Test-Actor', gm())
      .send({ version: 1, status: 'ACTIVE' })
      .expect(200);

    const [job] = await list();
    await work(job!, 'accept', 'start');
    expect((await list())[0]!.status).toBe('IN_PROGRESS');
    expect(await housekeeping('101')).toBe('CLEANING');
    await work(job!, 'complete');
    // A repeated delivery changes nothing and sends nothing twice.
    await jobs().follow(scope(), job!.workItemId);
    expect((await list())[0]!.status).toBe('DONE');
    expect(await housekeeping('101')).toBe('CLEAN');

    const history = (
      await h
        .http()
        .get(`${base()}/housekeeping/rooms/${room('101')}/history`)
        .set('X-Test-Actor', gm())
        .expect(200)
    ).body as Array<{ toValue: string; cause: string; jobId: string | null }>;
    expect(
      history.slice(0, 2).map((e) => `${e.toValue}:${e.cause}:${e.jobId === job!.id}`),
    ).toEqual(['CLEAN:JOB:true', 'CLEANING:JOB:true']);
    const commands = (
      await h.db.execute(
        sql`select command_type, payload from integration.integration_commands where instance_id = ${instance.id}`,
      )
    ).rows as Array<{ command_type: string; payload: unknown }>;
    expect(commands).toEqual([
      {
        command_type: 'SET_ROOM_STATUS',
        payload: { room_number: '101', status: 'CLEAN', occupied: false },
      },
    ]);
  });

  it('credits come from the property rules at creation; staff create and skip jobs', async () => {
    const rule = await h
      .http()
      .put(`${base()}/housekeeping/credit-rules`)
      .set('X-Test-Actor', gm())
      .send({ cleaningType: 'DEEP_CLEAN', credits: 2.5 })
      .expect(200);
    expect(rule.body).toMatchObject({ cleaningType: 'DEEP_CLEAN', roomTypeId: null, credits: 2.5 });
    // Setting it again replaces the rule rather than adding one.
    await h
      .http()
      .put(`${base()}/housekeeping/credit-rules`)
      .set('X-Test-Actor', gm())
      .send({ cleaningType: 'DEEP_CLEAN', credits: 3 })
      .expect(200);
    const rules = await h
      .http()
      .get(`${base()}/housekeeping/credit-rules`)
      .set('X-Test-Actor', gm())
      .expect(200);
    expect(rules.body).toMatchObject([{ cleaningType: 'DEEP_CLEAN', credits: 3 }]);

    const deep = (
      await h
        .http()
        .post(`${base()}/housekeeping/jobs`)
        .set('X-Test-Actor', gm())
        .send({ roomId: room('102'), cleaningType: 'DEEP_CLEAN' })
        .expect(201)
    ).body as JobView;
    expect(deep).toMatchObject({ origin: 'STAFF', credits: 3, status: 'OPEN' });
    const vip = (
      await h
        .http()
        .post(`${base()}/housekeeping/jobs`)
        .set('X-Test-Actor', gm())
        .send({ roomId: room('102'), cleaningType: 'VIP' })
        .expect(201)
    ).body as JobView;
    expect(vip.credits).toBe(1.5);
    const vipWork = await h.app
      .get<OperationsPublicApi>(OPERATIONS_API)
      .getWorkItem(hotel.tenantId, vip.workItemId);
    expect(vipWork!.priority).toBe('HIGH');

    const skipped = await h
      .http()
      .post(`${base()}/housekeeping/jobs/${vip.id}/skip`)
      .set('X-Test-Actor', gm())
      .send({ reason: 'Guest declined service' })
      .expect(200);
    expect(skipped.body).toMatchObject({ status: 'SKIPPED', skipReason: 'Guest declined service' });
    const cancelled = await h.app
      .get<OperationsPublicApi>(OPERATIONS_API)
      .getWorkItem(hotel.tenantId, vip.workItemId);
    expect(cancelled!.status).toBe('CANCELLED');
    await h
      .http()
      .post(`${base()}/housekeeping/jobs/${vip.id}/skip`)
      .set('X-Test-Actor', gm())
      .send({ reason: 'again' })
      .expect(409);
    await h
      .http()
      .post(`${base()}/housekeeping/jobs/${newId()}/skip`)
      .set('X-Test-Actor', gm())
      .send({ reason: 'none' })
      .expect(404);
    const [audit] = (
      await h.db.execute(
        sql`select actor_type, reason from audit.audit_log where tenant_id = ${hotel.tenantId} and action = 'hk.job.skip' and entity_id = ${vip.id}`,
      )
    ).rows as Array<{ actor_type: string; reason: string }>;
    expect(audit).toEqual({ actor_type: 'USER', reason: 'Guest declined service' });
  });

  it('with inspections on, a finished clean waits; a failed inspection reopens the room with a touch-up', async () => {
    await setting('hk.inspection.required', true);
    const deep = (await list()).find((j) => j.cleaningType === 'DEEP_CLEAN')!;
    await work(deep, 'accept', 'start', 'complete');
    expect(await housekeeping('102')).toBe('INSPECTING');

    const failed = await h
      .http()
      .post(`${base()}/housekeeping/jobs/${deep.id}/inspection`)
      .set('X-Test-Actor', gm())
      .send({ result: 'FAIL', notes: 'Bathroom mirror' })
      .expect(201);
    expect(failed.body.job.status).toBe('FAILED_INSPECTION');
    expect(failed.body.touchUp).toMatchObject({
      cleaningType: 'TOUCH_UP',
      origin: 'INSPECTION',
      credits: 0.3,
    });
    expect(await housekeeping('102')).toBe('DIRTY');
    // The failed job cannot be inspected again.
    await h
      .http()
      .post(`${base()}/housekeeping/jobs/${deep.id}/inspection`)
      .set('X-Test-Actor', gm())
      .send({ result: 'PASS' })
      .expect(409);

    const touchUp = (await list()).find((j) => j.id === failed.body.touchUp.id)!;
    expect(touchUp.priority).toBe('HIGH');
    await work(touchUp, 'accept', 'start', 'complete');
    expect(await housekeeping('102')).toBe('INSPECTING');
    // The supervisor used the room checklist: its result decides, once it is completed, at this room only.
    const checklist = (id: string, extra: Partial<InspectionSummary>): InspectionSummary => ({
      id,
      propertyId: hotel.propertyId,
      number: 1,
      locationId: room('102'),
      assetId: null,
      status: 'COMPLETED',
      result: 'PASS',
      score: 100,
      completedAt: new Date().toISOString(),
      source: 'HK_JOB',
      sourceRef: touchUp.id,
      ...extra,
    });
    const [running, elsewhere, done] = [newId(), newId(), newId()];
    CHECKLISTS.set(running, checklist(running, { status: 'IN_PROGRESS', result: null }));
    CHECKLISTS.set(elsewhere, checklist(elsewhere, { locationId: room('101') }));
    CHECKLISTS.set(done, checklist(done, {}));
    const inspectWith = (inspectionId: string) =>
      h
        .http()
        .post(`${base()}/housekeeping/jobs/${touchUp.id}/inspection`)
        .set('X-Test-Actor', gm())
        .send({ inspectionId });
    expect((await inspectWith(running).expect(409)).body.code).toBe(
      'hk.inspection.checklist_not_completed',
    );
    await inspectWith(elsewhere).expect(404);
    await inspectWith(newId()).expect(404);
    const passed = await inspectWith(done).expect(201);
    expect(passed.body).toMatchObject({ job: { status: 'INSPECTED' }, touchUp: null });
    expect(await housekeeping('102')).toBe('INSPECTED');

    const inspections = (
      await h.db.execute(
        sql`select result, inspector_id, checklist_inspection_id from hk.inspections where room_id = ${room('102')} order by inspected_at`,
      )
    ).rows as Array<{
      result: string;
      inspector_id: string;
      checklist_inspection_id: string | null;
    }>;
    expect(inspections.map((i) => i.result)).toEqual(['FAIL', 'PASS']);
    expect(inspections.map((i) => i.checklist_inspection_id)).toEqual([null, done]);
    expect(inspections[0]!.inspector_id).toBe(gmId);
    const refused = await h.db
      .execute(sql`update hk.inspections set result = 'PASS' where room_id = ${room('102')}`)
      .then(
        () => '',
        (e: Error) => String((e.cause as Error | undefined)?.message ?? e.message),
      );
    expect(refused).toMatch(/append-only/);
    // The inspected room was written back to the PMS once.
    const [written] = (
      await h.db.execute(
        sql`select count(*)::int as n from integration.integration_commands where tenant_id = ${hotel.tenantId} and payload->>'status' = 'INSPECTED'`,
      )
    ).rows as Array<{ n: number }>;
    expect(written!.n).toBe(1);
    await setting('hk.inspection.required', false);
  });

  it('the stayover sweep cleans occupied rooms once a day, after the property hour', async () => {
    // Room 504 is occupied (written directly, as the PMS projection does on a check-in).
    await h.db.execute(
      sql`insert into hk.room_states (room_id, tenant_id, property_id, occupancy)
        values (${room('504')}, ${hotel.tenantId}, ${hotel.propertyId}, 'OCCUPIED')
        on conflict (room_id) do update set occupancy = 'OCCUPIED'`,
    );
    // 05:00 in Cairo (UTC+3 in October): before the default 08:00, nothing yet.
    const early = new Date('2026-10-20T02:00:00Z');
    const later = new Date('2026-10-20T07:00:00Z');
    expect(await sweep(early)).toBe(0);
    expect(await sweep(later)).toBeGreaterThanOrEqual(1);
    expect(await sweep(later)).toBe(0);
    const stayovers = await list('?day=2026-10-20');
    expect(stayovers.map((j) => `${j.roomNumber}:${j.cleaningType}:${j.origin}`)).toEqual([
      '504:STAYOVER:GENERATED',
    ]);

    async function sweep(at: Date) {
      return jobs().generateDaily(at);
    }
  });

  it('isolates tenants: another tenant’s jobs are not found, and row-level security hides them', async () => {
    const [job] = await list();
    await h
      .http()
      .post(`/properties/${other.propertyId}/housekeeping/jobs/${job!.id}/skip`)
      .set('X-Test-Actor', gm(other.tenantId))
      .send({ reason: 'probe' })
      .expect(404);
    await h
      .http()
      .get(`${base()}/housekeeping/jobs`)
      .set('X-Test-Actor', gm(other.tenantId))
      .expect(404);
    await h
      .http()
      .post(`/properties/${other.propertyId}/housekeeping/jobs`)
      .set('X-Test-Actor', gm(other.tenantId))
      .send({ roomId: room('101'), cleaningType: 'DEEP_CLEAN' })
      .expect(404);
    const leaked = await h.db.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.tenant_id', ${other.tenantId}, true)`);
      return (
        await tx.execute(
          sql`select (select count(*)::int from hk.jobs where tenant_id = ${hotel.tenantId}) + (select count(*)::int from hk.inspections where tenant_id = ${hotel.tenantId}) as n`,
        )
      ).rows[0] as { n: number };
    });
    expect(leaked.n).toBe(0);
  });
});
