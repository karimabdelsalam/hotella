import { sql } from 'drizzle-orm';
import { createEnvelope, type EventEnvelope, GuestCheckedOut } from '@hotella/contracts-events';
import { GUEST_API, GUEST_SESSION_HEADER, type GuestPublicApi } from '@hotella/domain-guest/public';
import { OPERATIONS_API, type OperationsPublicApi } from '@hotella/domain-operations/public';
import { newId } from '@hotella/platform-database';
import { infraSkipReason, needsInfra, readTestInfra } from '@hotella/platform-testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { JobService } from './application/job.service';
import { ReadinessService } from './application/readiness.service';
import { RoomStateService } from './application/room-state.service';
import { setRoomSignalTool } from './application/signal-tool';
import { HOUSEKEEPING_API, type HousekeepingPublicApi } from './public';
import {
  ASSIGNABLE,
  createHotel,
  guestToken,
  type HkHarness,
  type Hotel,
  staff,
  startHousekeepingApp,
} from './testing/harness';

const stamp = Date.now().toString(36).toUpperCase();

interface Readiness {
  ready: boolean;
  occupied: boolean;
  dimensions: Array<{ dimension: string; result: string; reason: string | null }>;
}

describe.skipIf(needsInfra())(
  `Housekeeping readiness, arrivals, assignment (${infraSkipReason()})`,
  () => {
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
      'task.read',
      'task.accept',
      'task.complete',
      'task.assign',
      'config.read',
      'config.manage',
    ];
    let h: HkHarness;
    let hotel: Hotel;
    const gm = () => staff(gmId, hotel.tenantId);
    const base = () => `/properties/${hotel.propertyId}`;
    const room = (n: string) => hotel.rooms[n]!;
    const readiness = async (n: string) =>
      (
        await h
          .http()
          .get(`${base()}/housekeeping/rooms/${room(n)}/readiness`)
          .set('X-Test-Actor', gm())
          .expect(200)
      ).body as Readiness;
    const readyEvents = async () =>
      (
        (
          await h.db.execute(
            sql`select envelope from platform.outbox where tenant_id = ${hotel.tenantId} and event_type = 'hk.room.ready' order by id`,
          )
        ).rows as Array<{ envelope: EventEnvelope }>
      ).map((r) => (r.envelope.payload as { room_id: string }).room_id);
    const setting = (key: string, value: unknown) =>
      h
        .http()
        .put(`/config/values/${key}`)
        .set('X-Test-Actor', gm())
        .send({ scope: 'PROPERTY', tenantId: hotel.tenantId, propertyId: hotel.propertyId, value })
        .expect(200);
    const clean = async (n: string) => {
      const rooms = (
        await h.http().get(`${base()}/housekeeping/rooms`).set('X-Test-Actor', gm()).expect(200)
      ).body as Array<{ roomNumber: string; version: number }>;
      let version = rooms.find((r) => r.roomNumber === n)!.version;
      for (const state of ['CLEANING', 'CLEAN'])
        version = (
          await h
            .http()
            .post(`${base()}/housekeeping/rooms/${room(n)}/state`)
            .set('X-Test-Actor', gm())
            .send({ housekeeping: state, version })
            .expect(200)
        ).body.version;
    };

    beforeAll(async () => {
      h = await startHousekeepingApp(url, 'hotella_app_hk_ready', { [gmId]: STAFF });
      hotel = await createHotel(h, `hkr-${stamp}`, gmId, ['101', '102', '201', '504']);
    });
    afterAll(() => h?.app.close());

    it('a room left by its guest becomes ready once cleaned; open engineering work holds it back', async () => {
      await h.app.get(RoomStateService).applyPms(
        createEnvelope(GuestCheckedOut, {
          eventId: newId(),
          tenantId: hotel.tenantId,
          propertyId: hotel.propertyId,
          source: 'integration',
          correlationId: `hk-ready-${stamp}`,
          occurredAt: new Date(),
          payload: {
            reservation: {
              integration_instance_id: newId(),
              external_id: `R-${stamp}`,
              confirmation_number: null,
            },
            room: { room_id: room('101'), room_number: '101' },
            checked_out_at: new Date().toISOString(),
          },
        } as never) as EventEnvelope,
      );
      expect(await readiness('101')).toMatchObject({
        ready: false,
        dimensions: [
          { dimension: 'HOUSEKEEPING', result: 'FAIL', reason: 'NOT_CLEAN' },
          { dimension: 'ENGINEERING', result: 'PASS' },
          { dimension: 'NO_OOO', result: 'PASS' },
        ],
      });
      await clean('101');
      expect((await readiness('101')).ready).toBe(true);
      expect(await readyEvents()).toEqual([room('101')]);

      // A leaking tap is reported in the room: it is not ready until engineering closes the work.
      const ops = h.app.get<OperationsPublicApi>(OPERATIONS_API);
      const work = await ops.createWorkItem({
        tenantId: hotel.tenantId,
        propertyId: hotel.propertyId,
        kind: 'HK_JOB',
        source: { module: 'test', entityType: 'test', entityId: null },
        title: { text: 'Leaking tap' },
        locationId: room('101'),
        departmentCode: 'ENG',
      });
      const deliver = () =>
        h.app.get(ReadinessService).apply({
          tenant_id: hotel.tenantId,
          property_id: hotel.propertyId,
          payload: { work_item_id: work.id },
        } as unknown as EventEnvelope);
      await deliver();
      expect(await readiness('101')).toMatchObject({
        ready: false,
        dimensions: [
          {},
          { dimension: 'ENGINEERING', result: 'FAIL', reason: 'OPEN_ENGINEERING_WORK' },
          {},
        ],
      });
      const board = (
        await h.http().get(`${base()}/housekeeping/rooms`).set('X-Test-Actor', gm()).expect(200)
      ).body as Array<{ roomNumber: string; ready: boolean }>;
      expect(board.find((r) => r.roomNumber === '101')!.ready).toBe(false);
      await ops.cancelWorkItem(hotel.tenantId, work.id, 'FIXED');
      await deliver();
      expect((await readiness('101')).ready).toBe(true);
      expect(await readyEvents()).toEqual([room('101'), room('101')]);

      // A property that inspects: clean is not enough.
      await setting('hk.readiness.dimensions', ['HOUSEKEEPING', 'INSPECTION']);
      expect(await readiness('101')).toMatchObject({
        ready: false,
        dimensions: [{ result: 'PASS' }, { dimension: 'INSPECTION', reason: 'NOT_INSPECTED' }],
      });
      await setting('hk.readiness.dimensions', ['HOUSEKEEPING', 'ENGINEERING', 'NO_OOO']);
    });

    it('an expected arrival in a vacant clean room gets an ARRIVAL check when the property asks for it', async () => {
      const day = '2026-10-21';
      const stayId = newId();
      await h.db
        .execute(sql`insert into guest.stays (id, tenant_id, property_id, status, primary_guest_id, expected_arrival, expected_departure, last_pms_event_at)
      values (${stayId}, ${hotel.tenantId}, ${hotel.propertyId}, 'EXPECTED', ${hotel.guestId}, ${day}, '2026-10-24', now())`);
      await h.db
        .execute(sql`insert into guest.room_assignments (id, tenant_id, property_id, stay_id, room_id, assigned_at, reason)
      values (${newId()}, ${hotel.tenantId}, ${hotel.propertyId}, ${stayId}, ${room('101')}, now(), 'PRE_ASSIGNMENT')`);
      const arrivals = await h.app
        .get<GuestPublicApi>(GUEST_API)
        .expectedArrivals(hotel.tenantId, hotel.propertyId, day);
      expect(arrivals.map((s) => [s.id, s.currentRoomId])).toEqual([[stayId, room('101')]]);

      const at = new Date(`${day}T07:00:00Z`);
      const jobs = h.app.get(JobService);
      await jobs.generateDaily(at);
      const list = async () =>
        (
          await h
            .http()
            .get(`${base()}/housekeeping/jobs?day=${day}`)
            .set('X-Test-Actor', gm())
            .expect(200)
        ).body as Array<{ roomNumber: string; cleaningType: string; stayId: string | null }>;
      expect((await list()).filter((j) => j.cleaningType === 'ARRIVAL')).toEqual([]);
      await setting('hk.arrival.clean', true);
      await jobs.generateDaily(at);
      await jobs.generateDaily(at);
      expect((await list()).filter((j) => j.cleaningType === 'ARRIVAL')).toMatchObject([
        { roomNumber: '101', stayId },
      ]);
    });

    it('the supervisor gets a balanced proposal by floor and applies it; nothing is assigned before that', async () => {
      const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Cairo' }).format(new Date());
      for (const [n, type] of [
        ['102', 'DEEP_CLEAN'],
        ['201', 'CHECKOUT'],
        ['504', 'STAYOVER'],
      ] as const)
        await h
          .http()
          .post(`${base()}/housekeeping/jobs`)
          .set('X-Test-Actor', gm())
          .send({ roomId: room(n), cleaningType: type })
          .expect(201);
      const [amal, badr] = [newId(), newId()];
      const proposal = await h
        .http()
        .post(`${base()}/housekeeping/assignments/proposal`)
        .set('X-Test-Actor', gm())
        .send({ attendantIds: [amal, badr] })
        .expect(200);
      expect(proposal.body).toMatchObject({ day, totalCredits: 3.7 });
      const plan = proposal.body.plan as Array<{
        attendantId: string;
        credits: number;
        jobs: Array<{ jobId: string; roomNumber: string }>;
      }>;
      // Floor 1 (a deep clean, 2.0) to one attendant; floors 2 and 5 (1.0 + 0.7) to the other.
      expect(plan.map((p) => [p.attendantId, p.credits, p.jobs.map((j) => j.roomNumber)])).toEqual([
        [amal, 2, ['102']],
        [badr, 1.7, ['201', '504']],
      ]);
      const before = (
        await h.http().get(`${base()}/housekeeping/jobs`).set('X-Test-Actor', gm()).expect(200)
      ).body as Array<{ assignee: unknown }>;
      expect(
        before.every(
          (j) => j.assignee === null || (j.assignee as { type: string }).type === 'TEAM',
        ),
      ).toBe(true);

      const assignments = plan.flatMap((p) =>
        p.jobs.map((j) => ({ jobId: j.jobId, userId: p.attendantId })),
      );
      // Not someone who can take housekeeping tasks: nothing is assigned at all.
      await h
        .http()
        .post(`${base()}/housekeeping/assignments`)
        .set('X-Test-Actor', gm())
        .send({ assignments })
        .expect(422);
      ASSIGNABLE.add(amal);
      ASSIGNABLE.add(badr);
      await h
        .http()
        .post(`${base()}/housekeeping/assignments`)
        .set('X-Test-Actor', gm())
        .send({ assignments })
        .expect(200, { assigned: 3 });
      const after = (
        await h.http().get(`${base()}/housekeeping/jobs`).set('X-Test-Actor', gm()).expect(200)
      ).body as Array<{ roomNumber: string; assignee: { type: string; id: string } | null }>;
      expect(
        Object.fromEntries(
          after.filter((j) => j.roomNumber !== '101').map((j) => [j.roomNumber, j.assignee?.id]),
        ),
      ).toEqual({ '102': amal, '201': badr, '504': badr });
    });

    it('the guest and the concierge set do-not-disturb or make-up-room for the guest’s own room; make-up-room jobs come first', async () => {
      const token = await guestToken(h, hotel);
      const signals = (method: 'get' | 'post', body?: object) =>
        method === 'get'
          ? h.http().get('/guest/room-signals').set(GUEST_SESSION_HEADER, token).expect(200)
          : h
              .http()
              .post('/guest/room-signals')
              .set(GUEST_SESSION_HEADER, token)
              .send(body)
              .expect(200);
      expect((await signals('get')).body).toEqual({ active: [] });

      const tool = setRoomSignalTool(
        h.app.get<HousekeepingPublicApi>(HOUSEKEEPING_API),
        h.app.get<GuestPublicApi>(GUEST_API),
      );
      const executionId = newId();
      const ctx = {
        tenantId: hotel.tenantId,
        propertyId: hotel.propertyId,
        executionId,
        agentCode: 'GUEST_CONCIERGE',
        locale: 'ar',
        guest: { guestId: hotel.guestId, stayId: hotel.stayId },
        conversationId: null,
      };
      expect(await tool.handle({ signal: 'MAKE_UP_ROOM', active: true }, ctx)).toEqual({
        active_signals: ['MAKE_UP_ROOM'],
      });
      expect((await signals('get')).body).toEqual({ active: ['MAKE_UP_ROOM'] });
      const [raised] = (
        await h.db.execute(
          sql`select source, started_by_type, started_by_id from hk.room_signals where room_id = ${room('504')} and signal = 'MAKE_UP_ROOM' and ended_at is null`,
        )
      ).rows as Array<{ source: string; started_by_type: string; started_by_id: string }>;
      expect(raised).toEqual({
        source: 'GUEST_PORTAL',
        started_by_type: 'AI_AGENT',
        started_by_id: executionId,
      });

      // Room 504's open clean is now first on the list, flagged.
      const jobs = (
        await h
          .http()
          .get(`${base()}/housekeeping/jobs?status=OPEN`)
          .set('X-Test-Actor', gm())
          .expect(200)
      ).body as Array<{ roomNumber: string; makeUpRequested: boolean; doNotDisturb: boolean }>;
      expect(jobs[0]).toMatchObject({
        roomNumber: '504',
        makeUpRequested: true,
        doNotDisturb: false,
      });

      expect((await signals('post', { signal: 'DND', active: true })).body.active).toEqual(['DND']);
      // A guest whose stay has no room (or another property's guest) cannot use it.
      await expect(
        tool.handle(
          { signal: 'DND', active: true },
          { ...ctx, guest: { guestId: hotel.guestId, stayId: newId() } },
        ),
      ).rejects.toMatchObject({ code: 'hk.signal.no_room' });
      await expect(
        tool.handle({ signal: 'DND', active: true }, { ...ctx, propertyId: newId() }),
      ).rejects.toMatchObject({ code: 'hk.signal.no_room' });
    });
  },
);
