import 'reflect-metadata';
import { Global, type INestApplication, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { ZodValidationPipe } from 'nestjs-zod';
import { Client } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GuestCoreModule } from '@hotella/domain-guest';
import { IDENTITY_API, type IdentityPublicApi } from '@hotella/domain-identity/public';
import { IntegrationsCoreModule } from '@hotella/domain-integrations';
import { OrganizationModule } from '@hotella/domain-organization';
import { AuditModule, auditSchema } from '@hotella/platform-audit';
import { ClsService } from 'nestjs-cls';
import {
  ActorStore,
  AUTHENTICATION_STRATEGY,
  AuthModule,
  HeaderActorStrategy,
  PERMISSION_RESOLVER,
  StaticPermissionResolver,
} from '@hotella/platform-auth';
import { ConfigModule } from '@hotella/platform-config';
import {
  applicationRoleUrl,
  DATABASE,
  type Database,
  DatabaseModule,
  newId,
  runMigrations,
  TransactionRunner,
  withTransaction,
} from '@hotella/platform-database';
import { EventPublisher, EventsModule, eventsSchema } from '@hotella/platform-events';
import { FeatureFlagsModule } from '@hotella/platform-flags';
import { HttpConventionsModule } from '@hotella/platform-http';
import { I18nModule } from '@hotella/platform-i18n';
import { ManifestModule } from '@hotella/platform-manifest';
import { LOGGER, ObservabilityModule } from '@hotella/platform-observability';
import { SettingsModule } from '@hotella/platform-settings';
import { infraSkipReason, needsInfra, readTestInfra } from '@hotella/platform-testing';
import { AlertService } from './application/alert.service';
import { ApprovalService } from './application/approval.service';
import { SlaMonitor } from './application/sla.service';
import { workflowDefinitionSchema } from './domain/workflow';
import {
  alerts,
  approvalRequests,
  escalations,
  slaInstances,
  taskEvents,
  tasks,
  workflowVersions,
  workItems,
} from './infrastructure/schema';
import { SlaRepositories } from './infrastructure/sla-repositories';
import { OperationsModule } from './operations.module';
import { OPERATIONS_API, type OperationsPublicApi } from './public';

const stamp = Date.now().toString(36).toUpperCase();
const SUPERVISOR = ['task.read', 'task.accept', 'task.complete', 'task.assign', 'task.cancel'];
const WORKER = ['task.read', 'task.accept', 'task.complete'];
const ORG = ['org.property.read', 'org.property.manage', 'org.location.manage'];

// Actor ids are UUIDs: they are stored as assignees and in the task history.
const ids = {
  gm: newId(),
  sup: newId(),
  w1: newId(),
  w2: newId(),
  viewer: newId(),
  other: newId(),
};
const grants: Record<string, string[]> = {
  [ids.gm]: [
    ...ORG,
    'org.department.manage',
    ...SUPERVISOR,
    'sla.manage',
    'alert.read',
    'alert.ack',
    'workflow.manage',
    'approval.read',
    'approval.decide',
  ],
  [ids.sup]: [...SUPERVISOR, 'alert.read', 'alert.ack', 'approval.read', 'approval.decide'],
  [ids.w1]: WORKER,
  [ids.w2]: WORKER,
  [ids.viewer]: ['task.read'],
  [ids.other]: [...ORG, ...SUPERVISOR],
};

/** Identity stand-in: who can take tasks follows the same grants as the permission resolver. */
@Global()
@Module({
  providers: [
    {
      provide: IDENTITY_API,
      useValue: {
        getStaffMember: async () => null,
        usersWithPermission: async (_t: string, _p: string, permission: string) =>
          Object.entries(grants)
            .filter(([, list]) => list.includes(permission))
            .map(([id]) => id),
      } satisfies IdentityPublicApi,
    },
  ],
  exports: [IDENTITY_API],
})
class FakeIdentityModule {}

describe.skipIf(needsInfra())(`Operations engine against PostgreSQL (${infraSkipReason()})`, () => {
  const url = readTestInfra().databaseUrl!;
  let app: INestApplication;
  let db: Database;
  let admin: Client;
  let ops: OperationsPublicApi;
  let monitor: SlaMonitor;
  let tenantA: string;
  let tenantB: string;
  let propertyA: string;
  let propertyB: string;
  let room: string;
  let stayId: string;
  let partyGuest: string;
  let strangerGuest: string;
  const http = () => request(app.getHttpServer());
  const actor = (id: string, tenantId: string | null = tenantA) =>
    JSON.stringify({ type: 'USER', id, tenantId, isPlatformAdmin: id === 'root' });
  const base = () => `/properties/${propertyA}`;
  /** Runs a direct OPERATIONS_API call as a given staff member (what an HTTP request or a job context provides). */
  const withActor = <T>(id: string, fn: () => Promise<T>): Promise<T> =>
    app.get(ClsService).run(async () => {
      app.get(ActorStore, { strict: false }).set({
        type: 'USER',
        id,
        tenantId: tenantA,
        isPlatformAdmin: false,
      });
      return fn();
    });
  const outbox = (type: string, aggregateId?: string) =>
    db
      .select()
      .from(eventsSchema.outbox)
      .where(
        and(
          eq(eventsSchema.outbox.tenantId, tenantA),
          eq(eventsSchema.outbox.eventType, type),
          aggregateId ? eq(eventsSchema.outbox.aggregateId, aggregateId) : undefined,
        ),
      )
      .orderBy(asc(eventsSchema.outbox.createdAt), asc(eventsSchema.outbox.id));
  const act = (taskId: string, action: string, who: string, body: object = {}) =>
    http().post(`${base()}/tasks/${taskId}/${action}`).set('X-Test-Actor', actor(who)).send(body);
  const work = (kind: string, extra: object = {}) =>
    ops.createWorkItem({
      tenantId: tenantA,
      propertyId: propertyA,
      kind,
      source: {
        module: kind === 'TEST_A_JOB' ? 'testa' : 'testb',
        entityType: 'thing',
        entityId: newId(),
      },
      title: { text: 'Fix the lamp' },
      ...extra,
    });

  beforeAll(async () => {
    await runMigrations(url);
    admin = new Client({ connectionString: url });
    await admin.connect();
    const env = {
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      DATABASE_URL: await applicationRoleUrl(url, 'hotella_app_ops'),
      VALKEY_URL: 'redis://127.0.0.1:1',
    };
    const ref = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ env }),
        ObservabilityModule.forRoot(),
        I18nModule.forRoot(),
        HttpConventionsModule.forRoot({ store: 'memory' }),
        DatabaseModule.forRoot(),
        EventsModule.forRoot(),
        FeatureFlagsModule,
        ManifestModule.forRoot(),
        AuditModule,
        SettingsModule,
        AuthModule.forRoot({
          strategy: { provide: AUTHENTICATION_STRATEGY, useClass: HeaderActorStrategy },
          resolver: {
            provide: PERMISSION_RESOLVER,
            useValue: new StaticPermissionResolver(grants),
          },
          propertyVerifier: OrganizationModule.propertyVerifier(),
        }),
        FakeIdentityModule,
        OrganizationModule,
        IntegrationsCoreModule,
        GuestCoreModule,
        OperationsModule,
      ],
    }).compile();
    app = ref.createNestApplication({ logger: false });
    app.useGlobalPipes(new ZodValidationPipe());
    await app.init();
    db = app.get(DATABASE);
    ops = app.get(OPERATIONS_API);
    // Two future modules register their kinds of work; neither owns a task table.
    ops.registerWorkItemKind({ code: 'TEST_A_JOB', module: 'testa', descriptionKey: 'x' });
    ops.registerWorkItemKind({ code: 'TEST_B_ORDER', module: 'testb', descriptionKey: 'x' });
    ops.registerWorkItemKind({ code: 'TEST_SLA_JOB', module: 'testb', descriptionKey: 'x' });
    monitor = new SlaMonitor(
      app.get(SlaRepositories),
      app.get(AlertService),
      app.get(EventPublisher),
      app.get(TransactionRunner),
      app.get(LOGGER),
    );

    const root = actor('root', null);
    tenantA = (
      await http()
        .post('/tenants')
        .set('X-Test-Actor', root)
        .send({ code: `ops-a-${stamp}`, name: 'A' })
        .expect(201)
    ).body.id;
    tenantB = (
      await http()
        .post('/tenants')
        .set('X-Test-Actor', root)
        .send({ code: `ops-b-${stamp}`, name: 'B' })
        .expect(201)
    ).body.id;
    const property = (tenant: string, who: string) =>
      http()
        .post('/properties')
        .set('X-Test-Actor', actor(who, tenant))
        .send({ code: 'OPS', name: 'Ops', timezone: 'Africa/Cairo', currency: 'EGP' })
        .expect(201)
        .then((r) => r.body.id as string);
    propertyA = await property(tenantA, ids.gm);
    propertyB = await property(tenantB, ids.other);
    const tree = await http()
      .get(`${base()}/locations`)
      .set('X-Test-Actor', actor(ids.gm))
      .expect(200);
    room = (
      await http()
        .post(`${base()}/rooms`)
        .set('X-Test-Actor', actor(ids.gm))
        .send({ parentId: tree.body[0].id, roomNumber: '101' })
        .expect(201)
    ).body.locationId;
    // A stay with a party, as the PMS projection would have written it.
    partyGuest = newId();
    strangerGuest = newId();
    stayId = newId();
    await admin.query(
      `insert into guest.guests (id, tenant_id, given_name) values ($1, $3, 'Amira'), ($2, $3, 'Omar')`,
      [partyGuest, strangerGuest, tenantA],
    );
    await admin.query(
      `insert into guest.stays (id, tenant_id, property_id, status, primary_guest_id, expected_arrival,
         expected_departure, last_pms_event_at) values ($1, $2, $3, 'IN_HOUSE', $4, '2026-10-01', '2026-10-05', now())`,
      [stayId, tenantA, propertyA, partyGuest],
    );
    await admin.query(
      `insert into guest.stay_party_members (id, tenant_id, stay_id, guest_id, role, joined_at)
       values ($1, $2, $3, $4, 'PRIMARY', now())`,
      [newId(), tenantA, stayId, partyGuest],
    );
  });
  afterAll(async () => {
    await app?.close();
    await admin?.end();
  });

  it('departments belong to a property, have unique codes and localized names', async () => {
    for (const [code, en, ar] of [
      ['HK', 'Housekeeping', 'التدبير الفندقي'],
      ['ENG', 'Engineering', 'الهندسة'],
    ])
      await http()
        .post(`${base()}/departments`)
        .set('X-Test-Actor', actor(ids.gm))
        .send({
          code,
          translations: [
            { locale: 'en', name: en },
            { locale: 'ar', name: ar },
          ],
        })
        .expect(201);
    const dup = await http()
      .post(`${base()}/departments`)
      .set('X-Test-Actor', actor(ids.gm))
      .send({ code: 'hk', translations: [{ locale: 'en', name: 'Again' }] })
      .expect(409);
    expect(dup.body.code).toBe('org.department.code_taken');
    const list = await http()
      .get(`${base()}/departments?lang=ar`)
      .set('X-Test-Actor', actor(ids.gm))
      .expect(200);
    expect(list.body.map((d: { code: string; name: string }) => [d.code, d.name])).toEqual([
      ['ENG', 'الهندسة'],
      ['HK', 'التدبير الفندقي'],
    ]);
    // Supervisors cannot restructure the property.
    await http()
      .post(`${base()}/departments`)
      .set('X-Test-Actor', actor(ids.sup))
      .send({ code: 'FO', translations: [{ locale: 'en', name: 'Front office' }] })
      .expect(403);
  });

  it('two modules create work through one engine: tasks, history and events without a module task table', async () => {
    const a = await work('TEST_A_JOB', {
      departmentCode: 'HK',
      locationId: room,
      priority: 'HIGH',
    });
    expect(a).toMatchObject({ kind: 'TEST_A_JOB', status: 'OPEN', departmentCode: 'HK' });
    expect(a.tasks).toHaveLength(1);
    expect(a.tasks[0]).toMatchObject({
      status: 'NEW',
      departmentCode: 'HK',
      locationId: room,
      priority: 'HIGH',
    });

    const b = await work('TEST_B_ORDER', {
      departmentCode: 'ENG',
      stayId,
      guestId: partyGuest,
      title: { key: 'ops.permission.task_read' },
      tasks: [
        { assignTo: { type: 'USER', userId: ids.w1 } },
        { title: { text: 'Order the part' }, departmentCode: 'HK' },
      ],
    });
    expect(b.tasks.map((t) => [t.status, t.departmentCode, t.assignee?.type ?? null])).toEqual([
      ['ASSIGNED', 'ENG', 'USER'],
      ['NEW', 'HK', null],
    ]);
    expect((await outbox('ops.work_item.created')).map((e) => e.aggregateId)).toEqual(
      expect.arrayContaining([a.id, b.id]),
    );
    const assigned = await outbox('ops.task.assigned', b.tasks[0]!.id);
    expect(assigned[0]!.envelope).toMatchObject({
      payload: { assignee: { type: 'USER', id: ids.w1 }, previous: null },
    });
    // The localized title is rendered for the viewer; quoted text is returned as written.
    const view = await http()
      .get(`${base()}/work-items/${b.id}`)
      .set(
        'X-Test-Actor',
        JSON.stringify({ type: 'USER', id: ids.sup, tenantId: tenantA, locale: 'ar' }),
      )
      .set('Accept-Language', 'ar')
      .expect(200);
    expect(view.body.title).toBe('عرض المهام وأعمال التشغيل');
    expect(view.body.tasks[1].title).toBe('Order the part');
    expect(view.body.tasks[0].history.map((h: { type: string }) => h.type)).toEqual([
      'CREATE',
      'ASSIGN',
    ]);

    // The only task tables are the engine's own: no module brought a task table of its own.
    const tables = await admin.query<{ table_schema: string; table_name: string }>(
      `select table_schema, table_name from information_schema.tables
       where table_name like '%task%' and table_schema not in ('pg_catalog', 'information_schema')
       order by 1, 2`,
    );
    expect(tables.rows.map((r) => `${r.table_schema}.${r.table_name}`)).toEqual([
      'ops.task_assignments',
      'ops.task_events',
      'ops.tasks',
    ]);
  });

  it('refuses unknown kinds and references that do not belong to the property', async () => {
    await expect(work('NOT_REGISTERED')).rejects.toMatchObject({
      code: 'ops.work_item.kind_unknown',
    });
    await expect(work('TEST_A_JOB', { departmentCode: 'SPA' })).rejects.toMatchObject({
      code: 'ops.work_item.reference_invalid',
      params: { field: 'departmentCode' },
    });
    await expect(work('TEST_A_JOB', { locationId: newId() })).rejects.toMatchObject({
      params: { field: 'locationId' },
    });
    await expect(work('TEST_A_JOB', { stayId: newId() })).rejects.toMatchObject({
      params: { field: 'stayId' },
    });
    await expect(work('TEST_A_JOB', { stayId, guestId: strangerGuest })).rejects.toMatchObject({
      params: { field: 'guestId' },
    });
    await expect(work('TEST_A_JOB', { guestId: partyGuest })).rejects.toMatchObject({
      params: { field: 'guestId' },
    });
    await expect(
      work('TEST_A_JOB', { tasks: [{ assignTo: { type: 'USER', userId: ids.viewer } }] }),
    ).rejects.toMatchObject({ code: 'ops.task.assignee_invalid' });
    expect(() =>
      ops.registerWorkItemKind({ code: 'TEST_A_JOB', module: 'someone_else', descriptionKey: 'x' }),
    ).toThrow(/already registered/);
  });

  it('keeps the complete assignment history through assign → reassign → unassign', async () => {
    const item = await work('TEST_A_JOB');
    const taskId = item.tasks[0]!.id;
    await act(taskId, 'assign', ids.sup, { assignee: { type: 'USER', userId: ids.w1 } }).expect(
      200,
    );
    await act(taskId, 'assign', ids.sup, {
      assignee: { type: 'USER', userId: ids.w2 },
      reason: 'w1 went home',
    }).expect(200);
    const unassigned = await act(taskId, 'unassign', ids.sup).expect(200);
    expect(unassigned.body).toMatchObject({ status: 'NEW', assignee: null });

    const detail = await http()
      .get(`${base()}/tasks/${taskId}`)
      .set('X-Test-Actor', actor(ids.sup))
      .expect(200);
    expect(
      detail.body.assignments.map(
        (a: { assignee: { id: string }; endReason: string | null; reason: string | null }) => [
          a.assignee.id,
          a.endReason,
          a.reason,
        ],
      ),
    ).toEqual([
      [ids.w1, 'REASSIGNED', null],
      [ids.w2, 'UNASSIGNED', 'w1 went home'],
    ]);
    expect(
      detail.body.assignments.every((a: { unassignedAt: string | null }) => a.unassignedAt),
    ).toBe(true);
    expect(
      detail.body.history.map((h: { type: string; to: string }) => `${h.type}:${h.to}`),
    ).toEqual(['CREATE:NEW', 'ASSIGN:ASSIGNED', 'ASSIGN:ASSIGNED', 'UNASSIGN:NEW']);
    const audit = await db
      .select()
      .from(auditSchema.auditLog)
      .where(
        and(
          eq(auditSchema.auditLog.entityId, taskId),
          eq(auditSchema.auditLog.action, 'ops.task.assign'),
        ),
      );
    expect(audit).toHaveLength(2);
  });

  it('a department member claims queued work, pauses with a reason and finishes; the work item resolves', async () => {
    const item = await work('TEST_B_ORDER', {
      tasks: [{ assignTo: { type: 'TEAM', departmentCode: 'HK' } }],
    });
    const taskId = item.tasks[0]!.id;
    const queue = await http()
      .get(`${base()}/tasks?department=HK&status=ASSIGNED`)
      .set('X-Test-Actor', actor(ids.w1))
      .expect(200);
    expect(queue.body.items.map((t: { id: string }) => t.id)).toContain(taskId);

    const started = await act(taskId, 'start', ids.w1).expect(200);
    expect(started.body).toMatchObject({
      status: 'IN_PROGRESS',
      assignee: { type: 'USER', id: ids.w1 },
    });
    const mine = await http()
      .get(`${base()}/tasks?assignee=me`)
      .set('X-Test-Actor', actor(ids.w1))
      .expect(200);
    expect(mine.body.items.map((t: { id: string }) => t.id)).toContain(taskId);

    expect((await act(taskId, 'pause', ids.w1).expect(400)).body.code).toBe(
      'platform.validation_failed',
    );
    await act(taskId, 'pause', ids.w1, { reason: 'WAITING_PARTS' }).expect(200);
    await act(taskId, 'resume', ids.w1).expect(200);
    const done = await act(taskId, 'complete', ids.w1, { reason: 'Lamp replaced' }).expect(200);
    expect(done.body.status).toBe('DONE');

    const detail = await http()
      .get(`${base()}/tasks/${taskId}`)
      .set('X-Test-Actor', actor(ids.w1))
      .expect(200);
    expect(detail.body.history.map((h: { type: string }) => h.type)).toEqual([
      'CREATE',
      'ASSIGN',
      'CLAIM',
      'START',
      'PAUSE',
      'RESUME',
      'COMPLETE',
    ]);
    expect(
      detail.body.assignments.map((a: { assignee: { type: string }; endReason: string }) => [
        a.assignee.type,
        a.endReason,
      ]),
    ).toEqual([
      ['TEAM', 'CLAIMED'],
      ['USER', 'COMPLETED'],
    ]);
    expect(detail.body).toMatchObject({ workItem: { status: 'RESOLVED' } });
    const changes = await outbox('ops.work_item.status_changed', item.id);
    expect(changes.map((c) => (c.envelope as { payload: { to: string } }).payload.to)).toEqual([
      'IN_PROGRESS',
      'RESOLVED',
    ]);
  });

  it('only the assignee or a supervisor acts on a task, and illegal or stale moves are refused', async () => {
    const item = await work('TEST_A_JOB', {
      tasks: [{ assignTo: { type: 'USER', userId: ids.w1 } }],
    });
    const taskId = item.tasks[0]!.id;
    expect((await act(taskId, 'complete', ids.w2).expect(403)).body.code).toBe(
      'ops.task.not_assignee',
    );
    await act(taskId, 'assign', ids.w1, { assignee: { type: 'USER', userId: ids.w2 } }).expect(403);
    await act(taskId, 'accept', ids.viewer).expect(403);
    expect(
      (
        await act(taskId, 'assign', ids.sup, {
          assignee: { type: 'USER', userId: ids.viewer },
        }).expect(422)
      ).body.code,
    ).toBe('ops.task.assignee_invalid');
    const stale = await act(taskId, 'accept', ids.w1, { expectedVersion: 99 }).expect(409);
    expect(stale.body.code).toBe('ops.task.version_conflict');
    const accepted = await act(taskId, 'accept', ids.w1, { expectedVersion: 1 }).expect(200);
    expect((await act(taskId, 'accept', ids.w1).expect(409)).body.code).toBe(
      'ops.task.transition_not_allowed',
    );
    // A supervisor finishes it for the assignee: allowed, and audited as acting on their behalf.
    await act(taskId, 'complete', ids.sup, { expectedVersion: accepted.body.version }).expect(200);
    const audit = await db
      .select()
      .from(auditSchema.auditLog)
      .where(
        and(
          eq(auditSchema.auditLog.entityId, taskId),
          eq(auditSchema.auditLog.action, 'ops.task.complete'),
        ),
      );
    expect(audit[0]).toMatchObject({ actorId: ids.sup, after: { status: 'DONE', onBehalf: true } });
    await act(taskId, 'cancel', ids.sup, { reason: 'too late' }).expect(409);
  });

  it('the source module withdraws its work: open tasks are cancelled, finished ones stay', async () => {
    const item = await work('TEST_B_ORDER', {
      tasks: [{ assignTo: { type: 'USER', userId: ids.w1 } }, {}],
    });
    await act(item.tasks[0]!.id, 'complete', ids.w1).expect(200);
    const cancelled = await ops.cancelWorkItem(tenantA, item.id, 'guest cancelled the request');
    expect(cancelled.status).toBe('RESOLVED');
    expect(cancelled.tasks.map((t) => t.status)).toEqual(['DONE', 'CANCELLED']);
    const only = await work('TEST_B_ORDER');
    expect((await ops.cancelWorkItem(tenantA, only.id, 'duplicate')).status).toBe('CANCELLED');
    expect(await ops.workItemsForSource(tenantA, 'thing', newId())).toEqual([]);
    expect((await ops.getWorkItem(tenantB, only.id)) ?? null).toBeNull();
  });

  it('task history is append-only at the database level', async () => {
    const [event] = await db.select().from(taskEvents).limit(1);
    await expect(
      db.update(taskEvents).set({ type: 'FORGED' }).where(eq(taskEvents.id, event!.id)),
    ).rejects.toMatchObject({ cause: { message: expect.stringContaining('append-only') } });
    await expect(db.delete(taskEvents).where(eq(taskEvents.id, event!.id))).rejects.toMatchObject({
      cause: { message: expect.stringContaining('append-only') },
    });
  });

  it('never leaks across tenants (HTTP 404 and row-level security)', async () => {
    const item = await work('TEST_A_JOB');
    const taskId = item.tasks[0]!.id;
    // Another tenant's staff naming tenant A's property or task get 404, never 403.
    await http()
      .get(`${base()}/tasks/${taskId}`)
      .set('X-Test-Actor', actor(ids.other, tenantB))
      .expect(404);
    await http()
      .get(`/properties/${propertyB}/tasks/${taskId}`)
      .set('X-Test-Actor', actor(ids.other, tenantB))
      .expect(404);
    await http()
      .post(`/properties/${propertyB}/tasks/${taskId}/cancel`)
      .set('X-Test-Actor', actor(ids.other, tenantB))
      .send({ reason: 'probe' })
      .expect(404);
    const listed = await http()
      .get(`/properties/${propertyB}/work-items`)
      .set('X-Test-Actor', actor(ids.other, tenantB))
      .expect(200);
    expect(listed.body.items).toEqual([]);
    // Inside a tenant-B transaction the rows of tenant A do not exist.
    const seen = await withTransaction(
      db,
      (tx) =>
        tx
          .select({ id: tasks.id })
          .from(tasks)
          .where(inArray(tasks.workItemId, [item.id])),
      { tenantId: tenantB },
    );
    expect(seen).toEqual([]);
    const [own] = await withTransaction(
      db,
      (tx) =>
        tx
          .select({ n: sql<number>`count(*)::int` })
          .from(workItems)
          .where(eq(workItems.id, item.id)),
      { tenantId: tenantA },
    );
    expect(own!.n).toBe(1);
  });

  describe('SLA, escalation and alerts', () => {
    const MIN = 60_000;
    const sla = async (workItemId: string) =>
      (await db.select().from(slaInstances).where(eq(slaInstances.workItemId, workItemId)))[0]!;
    const gmPost = (path: string, body: object) =>
      http().post(`${base()}${path}`).set('X-Test-Actor', actor(ids.gm)).send(body);

    it('business hours and policies are validated, versioned and audited', async () => {
      expect(
        (await gmPost('/business-hours', { code: 'EMPTY', schedule: { days: {} } }).expect(422))
          .body.code,
      ).toBe('ops.business_hours.invalid');
      const days = Object.fromEntries(
        ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'].map((d) => [d, [['08:00', '20:00']]]),
      );
      const hours = (
        await gmPost('/business-hours', { code: 'day', schedule: { days } }).expect(201)
      ).body;
      expect(hours).toMatchObject({ code: 'DAY', version: 1 });
      await gmPost('/business-hours', { code: 'DAY', schedule: { days } }).expect(409);
      await http()
        .patch(`${base()}/business-hours/${hours.id}`)
        .set('X-Test-Actor', actor(ids.gm))
        .send({ version: 7, schedule: { days, closedDates: ['2026-12-25'] } })
        .expect(409);
      await http()
        .patch(`${base()}/business-hours/${hours.id}`)
        .set('X-Test-Actor', actor(ids.gm))
        .send({ version: 1, schedule: { days, closedDates: ['2026-12-25'] } })
        .expect(200);

      const policy = {
        code: 'HK_DAY',
        matchKind: 'TEST_A_JOB',
        matchDepartmentCode: 'HK',
        responseMinutes: 15,
        resolutionMinutes: 120,
        businessHoursCode: 'DAY',
        pauseReasons: ['waiting_guest'],
        escalationRules: [
          { level: 1, trigger: 'RESOLUTION_BREACH', offsetMinutes: 0, severity: 'WARNING' },
        ],
      };
      const created = (await gmPost('/sla-policies', policy).expect(201)).body;
      expect(created).toMatchObject({
        code: 'HK_DAY',
        businessHoursCode: 'DAY',
        pauseReasons: ['WAITING_GUEST'],
      });
      await gmPost('/sla-policies', policy).expect(409);
      expect(
        (await gmPost('/sla-policies', { ...policy, code: 'X1', matchKind: 'NOPE' }).expect(422))
          .body.code,
      ).toBe('ops.work_item.kind_unknown');
      await gmPost('/sla-policies', { ...policy, code: 'X2', matchDepartmentCode: 'SPA' }).expect(
        422,
      );
      await gmPost('/sla-policies', {
        ...policy,
        code: 'X3',
        escalationRules: [policy.escalationRules[0], policy.escalationRules[0]],
      }).expect(400);
      // Supervisors run the floor; they do not set the targets.
      await http().get(`${base()}/sla-policies`).set('X-Test-Actor', actor(ids.sup)).expect(403);
      // The policy follows a business-hours calendar in the property's time zone.
      const item = await work('TEST_A_JOB', { departmentCode: 'HK' });
      const instance = await sla(item.id);
      expect(instance).toMatchObject({
        policyId: created.id,
        status: 'RUNNING',
        calendar: { kind: 'BUSINESS_HOURS', timeZone: 'Africa/Cairo' },
      });
      expect(instance.resolutionDueAt.getTime()).toBeGreaterThan(instance.responseDueAt!.getTime());
    });

    it('the clock is met by taking the work on, pauses while the guest is awaited and stops when done', async () => {
      await gmPost('/sla-policies', {
        code: 'SLA_FAST',
        matchKind: 'TEST_SLA_JOB',
        responseMinutes: 15,
        resolutionMinutes: 60,
        pauseReasons: ['WAITING_GUEST'],
      }).expect(201);
      const item = await work('TEST_SLA_JOB', {
        tasks: [{ assignTo: { type: 'USER', userId: ids.w1 } }],
      });
      const taskId = item.tasks[0]!.id;
      const started = await sla(item.id);
      expect(started).toMatchObject({ status: 'RUNNING', calendar: { kind: 'ALWAYS' } });
      expect(started.responseDueAt!.getTime() - started.startedAt.getTime()).toBe(15 * MIN);
      expect(started.nextCheckAt).toEqual(started.responseDueAt);

      await act(taskId, 'start', ids.w1).expect(200);
      expect((await sla(item.id)).responseMetAt).not.toBeNull();
      // A pause for another reason does not stop the clock.
      await act(taskId, 'pause', ids.w1, { reason: 'BREAK' }).expect(200);
      expect((await sla(item.id)).status).toBe('RUNNING');
      await act(taskId, 'resume', ids.w1).expect(200);
      await act(taskId, 'pause', ids.w1, { reason: 'WAITING_GUEST' }).expect(200);
      const paused = await sla(item.id);
      expect(paused).toMatchObject({ status: 'PAUSED', nextCheckAt: null });
      await new Promise((r) => setTimeout(r, 30));
      await act(taskId, 'resume', ids.w1).expect(200);
      const resumed = await sla(item.id);
      expect(resumed.status).toBe('RUNNING');
      expect(resumed.resolutionDueAt.getTime()).toBeGreaterThan(started.resolutionDueAt.getTime());

      await act(taskId, 'complete', ids.w1).expect(200);
      const done = await sla(item.id);
      expect(done).toMatchObject({
        status: 'COMPLETED',
        nextCheckAt: null,
        resolutionBreachedAt: null,
      });
      const view = await http()
        .get(`${base()}/work-items/${item.id}`)
        .set('X-Test-Actor', actor(ids.sup))
        .expect(200);
      expect(view.body.sla).toMatchObject({
        status: 'COMPLETED',
        responseBreached: false,
        resolutionBreached: false,
      });
    });

    it('missed targets climb the escalation ladder into one deduplicated alert, and close with the work', async () => {
      await gmPost('/sla-policies', {
        code: 'SLA_LADDER',
        matchKind: 'TEST_SLA_JOB',
        matchPriority: 'URGENT',
        responseMinutes: 15,
        resolutionMinutes: 60,
        escalationRules: [
          {
            level: 1,
            trigger: 'RESPONSE_BREACH',
            offsetMinutes: 0,
            severity: 'WARNING',
            notifyRoles: ['duty_manager'],
          },
          { level: 1, trigger: 'RESOLUTION_BREACH', offsetMinutes: 0, severity: 'WARNING' },
          {
            level: 2,
            trigger: 'RESOLUTION_BREACH',
            offsetMinutes: 30,
            severity: 'CRITICAL',
            notifyRoles: ['GENERAL_MANAGER'],
          },
        ],
      }).expect(201);
      const item = await work('TEST_SLA_JOB', { priority: 'URGENT' });
      const instance = await sla(item.id);
      const at = (minutes: number) => new Date(instance.startedAt.getTime() + minutes * MIN);

      await monitor.sweep(at(10));
      expect(
        await db.select().from(escalations).where(eq(escalations.slaInstanceId, instance.id)),
      ).toEqual([]);
      await monitor.sweep(at(16));
      await monitor.sweep(at(16)); // idempotent
      const afterResponse = await sla(item.id);
      expect(afterResponse.responseBreachedAt).toEqual(afterResponse.responseDueAt);
      const steps = () =>
        db
          .select()
          .from(escalations)
          .where(eq(escalations.slaInstanceId, instance.id))
          .orderBy(asc(escalations.triggeredAt), asc(escalations.level));
      expect((await steps()).map((e) => `${e.trigger}:${e.level}`)).toEqual(['RESPONSE_BREACH:1']);
      expect((await steps())[0]!.notifyRoles).toEqual(['DUTY_MANAGER']);

      await monitor.sweep(at(61));
      await monitor.sweep(at(95));
      expect((await steps()).map((e) => `${e.trigger}:${e.level}`)).toEqual([
        'RESPONSE_BREACH:1',
        'RESOLUTION_BREACH:1',
        'RESOLUTION_BREACH:2',
      ]);
      const raised = await db
        .select()
        .from(alerts)
        .where(and(eq(alerts.subjectId, item.id), eq(alerts.status, 'OPEN')))
        .orderBy(asc(alerts.type));
      expect(raised.map((a) => [a.type, a.severity, a.occurrences])).toEqual([
        ['SLA_RESOLUTION_BREACHED', 'CRITICAL', 2],
        ['SLA_RESPONSE_BREACHED', 'WARNING', 1],
      ]);
      expect((await outbox('ops.sla.breached', instance.id)).length).toBe(2);
      expect((await outbox('ops.escalation.triggered', instance.id)).length).toBe(3);
      expect(await sla(item.id)).toMatchObject({ nextCheckAt: null, status: 'RUNNING' });

      // Taking the work on ends "nobody responded"; finishing it ends the breach.
      await act(item.tasks[0]!.id, 'start', ids.w1).expect(200);
      const open = async () =>
        (
          await db
            .select({ type: alerts.type })
            .from(alerts)
            .where(and(eq(alerts.subjectId, item.id), eq(alerts.status, 'OPEN')))
        ).map((a) => a.type);
      expect(await open()).toEqual(['SLA_RESOLUTION_BREACHED']);
      await act(item.tasks[0]!.id, 'complete', ids.w1).expect(200);
      expect(await open()).toEqual([]);
      expect(await sla(item.id)).toMatchObject({ status: 'COMPLETED' });
    });

    it('the same alert condition raised 50 times is one alert; staff acknowledge and resolve it', async () => {
      const key = `ac-failure-${stamp}`;
      const results = [];
      for (let i = 0; i < 50; i++)
        results.push(
          await ops.raiseAlert({
            tenantId: tenantA,
            propertyId: propertyA,
            type: 'REPEATED_AC_FAILURE',
            severity: i === 49 ? 'CRITICAL' : 'WARNING',
            dedupeKey: key,
            subject: { type: 'location', id: room },
            evidence: { last_reading: i },
          }),
        );
      expect(results.filter((r) => r.created)).toHaveLength(1);
      const [alert] = await db.select().from(alerts).where(eq(alerts.dedupeKey, key));
      expect(alert).toMatchObject({
        occurrences: 50,
        severity: 'CRITICAL',
        status: 'OPEN',
        evidence: { last_reading: 49 },
      });
      expect(alert!.lastSeenAt.getTime()).toBeGreaterThanOrEqual(alert!.firstSeenAt.getTime());
      expect((await outbox('ops.alert.raised', alert!.id)).length).toBe(1);

      const board = await http()
        .get(`${base()}/alerts?status=OPEN`)
        .set('X-Test-Actor', actor(ids.sup))
        .expect(200);
      expect(board.body.map((a: { id: string }) => a.id)).toContain(alert!.id);
      await http().get(`${base()}/alerts`).set('X-Test-Actor', actor(ids.w1)).expect(403);
      await http()
        .post(`${base()}/alerts/${alert!.id}/acknowledge`)
        .set('X-Test-Actor', actor(ids.sup))
        .expect(200);
      await http()
        .post(`${base()}/alerts/${alert!.id}/acknowledge`)
        .set('X-Test-Actor', actor(ids.sup))
        .expect(409);
      // Still the same condition while acknowledged.
      expect(
        (
          await ops.raiseAlert({
            tenantId: tenantA,
            propertyId: propertyA,
            type: 'REPEATED_AC_FAILURE',
            severity: 'WARNING',
            dedupeKey: key,
          })
        ).created,
      ).toBe(false);
      const resolved = await http()
        .post(`${base()}/alerts/${alert!.id}/resolve`)
        .set('X-Test-Actor', actor(ids.sup))
        .send({ resolution: 'Compressor replaced' })
        .expect(200);
      expect(resolved.body).toMatchObject({
        status: 'RESOLVED',
        resolution: 'Compressor replaced',
        resolvedBy: { type: 'USER', id: ids.sup },
      });
      // After resolution the condition can come back as a new alert.
      expect(
        (
          await ops.raiseAlert({
            tenantId: tenantA,
            propertyId: propertyA,
            type: 'REPEATED_AC_FAILURE',
            severity: 'WARNING',
            dedupeKey: key,
          })
        ).created,
      ).toBe(true);
      // Another tenant cannot see or touch it.
      await http()
        .post(`/properties/${propertyB}/alerts/${alert!.id}/acknowledge`)
        .set('X-Test-Actor', actor(ids.other, tenantB))
        .expect(403);
    });
  });

  describe('workflows and approvals', () => {
    const refunds: Array<{ id: string; payload: Record<string, unknown> }> = [];
    const gmPost = (path: string, body: object = {}) =>
      http().post(`${base()}${path}`).set('X-Test-Actor', actor(ids.gm)).send(body);
    const COMPENSATION = {
      initial: 'OPEN',
      states: {
        OPEN: {
          onEnter: [
            {
              type: 'create_task',
              params: { title: 'Check the complaint', assignToDepartment: 'HK' },
            },
          ],
        },
        AWAITING_APPROVAL: {
          onEnter: [
            { type: 'request_approval', params: { kind: 'TEST_REFUND', riskLevel: 'HIGH' } },
          ],
        },
        GRANTED: {
          terminal: true,
          onEnter: [{ type: 'create_task', params: { title: 'Hand over the voucher' } }],
        },
        DECLINED: { terminal: true },
        WITHDRAWN: {
          terminal: true,
          onEnter: [{ type: 'cancel_open_tasks', params: { reason: 'withdrawn' } }],
        },
      },
      transitions: [
        { from: 'OPEN', to: 'AWAITING_APPROVAL', on: 'TASK_COMPLETED', guards: ['all_tasks_done'] },
        { from: 'OPEN', to: 'WITHDRAWN', on: 'MANUAL:WITHDRAW' },
        { from: 'AWAITING_APPROVAL', to: 'GRANTED', on: 'APPROVAL_APPROVED' },
        { from: 'AWAITING_APPROVAL', to: 'DECLINED', on: 'APPROVAL_REJECTED' },
        { from: 'AWAITING_APPROVAL', to: 'DECLINED', on: 'APPROVAL_EXPIRED' },
      ],
    };
    const view = async (workItemId: string) =>
      (
        await http()
          .get(`${base()}/work-items/${workItemId}`)
          .set('X-Test-Actor', actor(ids.sup))
          .expect(200)
      ).body;
    const finishFirstTask = async (workItemId: string) => {
      const taskId = (await view(workItemId)).tasks[0].id;
      await act(taskId, 'start', ids.w1).expect(200);
      await act(taskId, 'complete', ids.w1).expect(200);
    };
    const pendingApproval = async (workItemId: string) =>
      (await view(workItemId)).approvals.find((a: { status: string }) => a.status === 'PENDING');

    beforeAll(() => {
      ops.registerApprovalKind({
        code: 'TEST_REFUND',
        module: 'testb',
        descriptionKey: 'x',
        handler: async (a) => {
          refunds.push({ id: a.id, payload: a.payload });
        },
      });
    });

    it('workflow versions are validated against registered guards and actions, published once and then frozen', async () => {
      await gmPost('/workflows', { code: 'compensation' }).expect(201);
      await gmPost('/workflows', { code: 'COMPENSATION' }).expect(409);
      await http().get(`${base()}/workflows`).set('X-Test-Actor', actor(ids.sup)).expect(403);
      const bad = await gmPost('/workflows/COMPENSATION/versions', {
        definition: {
          ...COMPENSATION,
          transitions: [
            { from: 'OPEN', to: 'DECLINED', on: 'TASK_COMPLETED', guards: ['moon_is_full'] },
          ],
        },
      }).expect(201);
      expect(bad.body).toMatchObject({ version: 1, status: 'DRAFT' });
      const refused = await gmPost('/workflows/COMPENSATION/versions/1/publish').expect(422);
      expect(refused.body).toMatchObject({ code: 'ops.workflow.invalid' });
      await gmPost('/workflows/COMPENSATION/versions', { definition: { initial: 'x' } }).expect(
        400,
      );
      await expect(work('TEST_B_ORDER', { workflowCode: 'COMPENSATION' })).rejects.toMatchObject({
        code: 'ops.workflow.not_published',
      });

      const good = await gmPost('/workflows/COMPENSATION/versions', {
        definition: COMPENSATION,
      }).expect(201);
      expect(good.body.version).toBe(2);
      const published = await gmPost('/workflows/COMPENSATION/versions/2/publish').expect(200);
      expect(published.body).toMatchObject({ status: 'PUBLISHED', publishedById: ids.gm });
      expect(
        (await gmPost('/workflows/COMPENSATION/versions/2/publish').expect(409)).body.code,
      ).toBe('ops.workflow.version_published');
      // The database refuses to rewrite or delete a published version (CLAUDE.md rule 9).
      await expect(
        db
          .update(workflowVersions)
          .set({
            definition: workflowDefinitionSchema.parse({ ...COMPENSATION, initial: 'DECLINED' }),
          })
          .where(eq(workflowVersions.id, good.body.id)),
      ).rejects.toMatchObject({ cause: { message: expect.stringContaining('immutable') } });
      await expect(
        db.delete(workflowVersions).where(eq(workflowVersions.id, good.body.id)),
      ).rejects.toMatchObject({
        cause: { message: expect.stringContaining('immutable') },
      });
    });

    it('drives the work: tasks, a HIGH-risk approval whose handler runs only once approved, then the follow-up', async () => {
      const item = await work('TEST_B_ORDER', { workflowCode: 'COMPENSATION' });
      expect(item.tasks.map((t) => [t.departmentCode, t.assignee?.type])).toEqual([['HK', 'TEAM']]);
      expect((await view(item.id)).workflow).toMatchObject({
        version: 2,
        state: 'OPEN',
        status: 'RUNNING',
      });

      await finishFirstTask(item.id);
      let v = await view(item.id);
      // The tasks are done, but the workflow is not: the work item stays in progress.
      expect(v).toMatchObject({ status: 'IN_PROGRESS', workflow: { state: 'AWAITING_APPROVAL' } });
      const approval = await pendingApproval(item.id);
      expect(approval).toMatchObject({
        kind: 'TEST_REFUND',
        riskLevel: 'HIGH',
        requestedBy: { type: 'USER', id: ids.w1 },
      });
      expect(refunds.find((r) => r.id === approval.id)).toBeUndefined();

      const inbox = await http()
        .get(`${base()}/approvals?status=PENDING`)
        .set('X-Test-Actor', actor(ids.sup))
        .expect(200);
      expect(inbox.body.map((a: { id: string }) => a.id)).toContain(approval.id);
      await http()
        .post(`${base()}/approvals/${approval.id}/decision`)
        .set('X-Test-Actor', actor(ids.w1))
        .send({ decision: 'APPROVE' })
        .expect(403);
      const decided = await http()
        .post(`${base()}/approvals/${approval.id}/decision`)
        .set('X-Test-Actor', actor(ids.sup))
        .send({ decision: 'APPROVE', reason: 'Long wait at check-in' })
        .expect(200);
      expect(decided.body).toMatchObject({
        status: 'APPROVED',
        decidedBy: { type: 'USER', id: ids.sup },
      });
      expect(decided.body.executedAt).not.toBeNull();
      expect(refunds.filter((r) => r.id === approval.id)).toHaveLength(1);
      await http()
        .post(`${base()}/approvals/${approval.id}/decision`)
        .set('X-Test-Actor', actor(ids.gm))
        .send({ decision: 'REJECT' })
        .expect(409);

      v = await view(item.id);
      expect(v.workflow).toMatchObject({ state: 'GRANTED', status: 'COMPLETED' });
      expect(
        v.workflow.history.map((h: { trigger: string; to: string }) => `${h.trigger}→${h.to}`),
      ).toEqual(['START→OPEN', 'TASK_COMPLETED→AWAITING_APPROVAL', 'APPROVAL_APPROVED→GRANTED']);
      expect(v.tasks.map((t: { title: string; status: string }) => [t.title, t.status])).toEqual([
        ['Check the complaint', 'DONE'],
        ['Hand over the voucher', 'NEW'],
      ]);
      expect(v.status).toBe('IN_PROGRESS');
      await act(v.tasks[1].id, 'assign', ids.sup, {
        assignee: { type: 'USER', userId: ids.w2 },
      }).expect(200);
      await act(v.tasks[1].id, 'complete', ids.w2).expect(200);
      expect((await view(item.id)).status).toBe('RESOLVED');
      expect(
        (await outbox('ops.approval.decided', approval.id)).map(
          (e) => (e.envelope as { payload: { outcome: string } }).payload.outcome,
        ),
      ).toEqual(['APPROVED']);
    });

    it('a rejected request never runs its handler; four eyes; a staff action withdraws the work', async () => {
      const rejected = await work('TEST_B_ORDER', { workflowCode: 'COMPENSATION' });
      await finishFirstTask(rejected.id);
      const approval = await pendingApproval(rejected.id);
      await http()
        .post(`${base()}/approvals/${approval.id}/decision`)
        .set('X-Test-Actor', actor(ids.gm))
        .send({ decision: 'REJECT', reason: 'Not eligible' })
        .expect(200);
      expect(refunds.find((r) => r.id === approval.id)).toBeUndefined();
      expect(await view(rejected.id)).toMatchObject({
        status: 'RESOLVED',
        workflow: { state: 'DECLINED' },
      });

      // Requested by a supervisor (through a direct request), decided by the same person: refused.
      const own = await withActor(ids.sup, () =>
        ops.requestApproval({
          tenantId: tenantA,
          propertyId: propertyA,
          kind: 'TEST_REFUND',
          riskLevel: 'HIGH',
          subject: { type: 'guest', id: partyGuest },
          payload: { amount: 500, currency: 'EGP' },
        }),
      );
      expect(
        (
          await http()
            .post(`${base()}/approvals/${own.id}/decision`)
            .set('X-Test-Actor', actor(ids.sup))
            .send({ decision: 'APPROVE' })
            .expect(403)
        ).body.code,
      ).toBe('ops.approval.four_eyes');
      await http()
        .post(`${base()}/approvals/${own.id}/decision`)
        .set('X-Test-Actor', actor(ids.gm))
        .send({ decision: 'APPROVE' })
        .expect(200);
      expect(refunds.find((r) => r.id === own.id)?.payload).toEqual({
        amount: 500,
        currency: 'EGP',
      });

      const withdrawn = await work('TEST_B_ORDER', { workflowCode: 'COMPENSATION' });
      await http()
        .post(`${base()}/work-items/${withdrawn.id}/workflow/actions`)
        .set('X-Test-Actor', actor(ids.sup))
        .send({ action: 'withdraw' })
        .expect(200);
      expect(await view(withdrawn.id)).toMatchObject({
        status: 'CANCELLED',
        workflow: { state: 'WITHDRAWN' },
      });
      expect(
        (
          await http()
            .post(`${base()}/work-items/${withdrawn.id}/workflow/actions`)
            .set('X-Test-Actor', actor(ids.sup))
            .send({ action: 'withdraw' })
            .expect(409)
        ).body.code,
      ).toBe('ops.workflow.transition_not_allowed');
    });

    it('an undecided request expires, closes and moves the workflow on', async () => {
      const item = await work('TEST_B_ORDER', { workflowCode: 'COMPENSATION' });
      await finishFirstTask(item.id);
      const approval = await pendingApproval(item.id);
      const expiries = app.get(ApprovalService);
      expect(await expiries.expireDue(new Date())).toBe(0);
      expect(
        await expiries.expireDue(new Date(Date.parse(approval.expiresAt) + 1_000)),
      ).toBeGreaterThanOrEqual(1);
      const [row] = await db
        .select()
        .from(approvalRequests)
        .where(eq(approvalRequests.id, approval.id));
      expect(row).toMatchObject({ status: 'EXPIRED', executedAt: null });
      expect(await view(item.id)).toMatchObject({
        status: 'RESOLVED',
        workflow: { state: 'DECLINED' },
      });
      expect(
        (
          await http()
            .post(`${base()}/approvals/${approval.id}/decision`)
            .set('X-Test-Actor', actor(ids.gm))
            .send({ decision: 'APPROVE' })
            .expect(409)
        ).body.code,
      ).toBe('ops.approval.not_pending');
      await expect(
        ops.requestApproval({
          tenantId: tenantA,
          propertyId: propertyA,
          kind: 'NOT_A_KIND',
          riskLevel: 'LOW',
          subject: { type: 'x' },
        }),
      ).rejects.toMatchObject({ code: 'ops.approval.kind_unknown' });
    });
  });
});
