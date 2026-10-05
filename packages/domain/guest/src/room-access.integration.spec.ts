import 'reflect-metadata';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { and, asc, eq, inArray, like, sql } from 'drizzle-orm';
import type { EventEnvelope } from '@hotella/contracts-events';
import { AccessService, IngestService, IntegrationsModule } from '@hotella/domain-integrations';
import { OrganizationModule } from '@hotella/domain-organization';
import { AuditModule } from '@hotella/platform-audit';
import {
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
  runMigrations,
  TransactionRunner,
} from '@hotella/platform-database';
import { EventsModule, eventsSchema, IdempotentConsumer } from '@hotella/platform-events';
import { FeatureFlagsModule } from '@hotella/platform-flags';
import { HttpConventionsModule } from '@hotella/platform-http';
import { I18nModule } from '@hotella/platform-i18n';
import { ManifestModule } from '@hotella/platform-manifest';
import { ObservabilityModule } from '@hotella/platform-observability';
import { SettingsModule } from '@hotella/platform-settings';
import { infraSkipReason, needsInfra, readTestInfra } from '@hotella/platform-testing';
import { ZodValidationPipe } from 'nestjs-zod';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { StayProjector } from './application/stay-projector';
import { GuestModule, projectOnce } from './guest.module';

const admin = JSON.stringify({ type: 'USER', id: 'admin', tenantId: null, isPlatformAdmin: true });
const user = (id: string, tenantId: string): string =>
  JSON.stringify({ type: 'USER', id, tenantId, isPlatformAdmin: false });
const stamp = Date.now().toString(36).toUpperCase();
const PERMS = [
  'org.property.read',
  'org.property.manage',
  'org.location.manage',
  'integration.read',
  'integration.configure',
  'integration.mapping.confirm',
  'stay.read',
  'access.read',
  'access.key.issue',
  'access.wifi.issue',
];

interface Grant {
  id: string;
  kind: string;
  status: string;
  roomNumber: string | null;
  revokeReason: string | null;
  connectorCode: string;
}

describe.skipIf(needsInfra())(`Stay-bound access (${infraSkipReason()})`, () => {
  const url = readTestInfra().databaseUrl!;
  let app: INestApplication;
  let db: Database;
  let ingest: IngestService;
  let project: ReturnType<typeof projectOnce>;
  let tenantA: string;
  let tenantB: string;
  let propertyA: string;
  let pms: string;
  let stayId: string;
  const grants: Record<string, string[]> = {
    gm: PERMS,
    other: PERMS,
    viewer: ['stay.read', 'access.read'],
  };
  let seq = 0;
  const applied = new Set<string>();
  const http = () => request(app.getHttpServer());
  const as = (id: string, tenantId = tenantA) => user(id, tenantId);
  const base = () => `/properties/${propertyA}`;
  const access = () => `${base()}/stays/${stayId}/access`;
  const send = (message_type: string, payload: unknown) =>
    ingest.ingest(pms, {
      message_type,
      source_message_id: `${stamp}-${++seq}`,
      sequence_no: seq,
      payload,
    });
  const fias = (record: string) => send('FIAS_RECORD', { record });
  const rows = async <T>(q: ReturnType<typeof sql>) => (await db.execute(q)).rows as unknown as T[];

  /** The worker, played in order: the stay projector, then the access consumer for the stay events. */
  async function drain(): Promise<void> {
    const outbox = () =>
      db
        .select()
        .from(eventsSchema.outbox)
        .where(
          and(
            eq(eventsSchema.outbox.tenantId, tenantA),
            like(eventsSchema.outbox.eventType, 'hotel.%'),
          ),
        )
        .orderBy(asc(eventsSchema.outbox.createdAt), asc(eventsSchema.outbox.id));
    for (const r of await outbox()) await project(r.envelope as EventEnvelope);
    const stayEvents = await db
      .select()
      .from(eventsSchema.outbox)
      .where(
        and(
          eq(eventsSchema.outbox.tenantId, tenantA),
          inArray(eventsSchema.outbox.eventType, [
            'guest.stay.status_changed',
            'guest.stay.room_changed',
          ]),
        ),
      )
      .orderBy(asc(eventsSchema.outbox.createdAt), asc(eventsSchema.outbox.id));
    // Each event once, as the worker's inbox guarantees.
    for (const r of stayEvents.filter((e) => !applied.has(e.id))) {
      applied.add(r.id);
      await app.get(AccessService).apply(r.envelope as EventEnvelope);
    }
  }
  const list = async () =>
    (await http().get(access()).set('X-Test-Actor', as('gm')).expect(200)).body as {
      available: string[];
      grants: Grant[];
    };
  const grant = async (id: string) => (await list()).grants.find((g) => g.id === id)!;
  const command = async (grantId: string, op: 'issue' | 'revoke') =>
    (
      await rows<{ id: string; command_type: string; payload: Record<string, unknown> }>(
        sql`select id, command_type, payload from integration.integration_commands where idempotency_key = ${`access:${grantId}:${op}`}`,
      )
    )[0];
  /** The lock or Wi-Fi system answers through the agent link. */
  const answer = (
    commandId: string,
    status: 'ACKNOWLEDGED' | 'FAILED',
    error: string | null = null,
  ) =>
    app
      .get(TransactionRunner)
      .run(() =>
        app.get(AccessService).onCommandResult({ tenantId: tenantA }, commandId, status, error),
      );
  const eventsOf = async (grantId: string) =>
    (
      await rows<{ event_type: string; payload: Record<string, unknown> }>(
        sql`select event_type, envelope->'payload' as payload from platform.outbox where aggregate_type = 'access_grant' and aggregate_id = ${grantId} order by id`,
      )
    ).map((r) => r.event_type);

  beforeAll(async () => {
    await runMigrations(url);
    const env = {
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      DATABASE_URL: await applicationRoleUrl(url, 'hotella_app_room_access'),
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
          stages: [IntegrationsModule.capabilityStage()],
        }),
        OrganizationModule,
        IntegrationsModule,
        GuestModule,
      ],
    }).compile();
    app = ref.createNestApplication({ logger: false });
    app.useGlobalPipes(new ZodValidationPipe());
    await app.init();
    db = app.get(DATABASE);
    ingest = app.get(IngestService);
    project = projectOnce(app.get(IdempotentConsumer), app.get(StayProjector));

    for (const code of ['a', 'b']) {
      const id = (
        await http()
          .post('/tenants')
          .set('X-Test-Actor', admin)
          .send({ code: `acc-${code}-${stamp}`, name: code })
          .expect(201)
      ).body.id as string;
      if (code === 'a') tenantA = id;
      else tenantB = id;
    }
    propertyA = (
      await http()
        .post('/properties')
        .set('X-Test-Actor', as('gm'))
        .send({ code: 'ACC', name: 'Access', timezone: 'Africa/Cairo', currency: 'EGP' })
        .expect(201)
    ).body.id;
    const tree = await http().get(`${base()}/locations`).set('X-Test-Actor', as('gm')).expect(200);
    const root = Array.isArray(tree.body) ? tree.body[0].id : tree.body.id;
    for (const n of ['504', '505'])
      await http()
        .post(`${base()}/rooms`)
        .set('X-Test-Actor', as('gm'))
        .send({ parentId: root, roomNumber: n })
        .expect(201);
    const instance = async (connectorCode: string, capabilities: string[]) => {
      const id = (
        await http()
          .post(`${base()}/integrations`)
          .set('X-Test-Actor', as('gm'))
          .send({ connectorCode, name: connectorCode, capabilities })
          .expect(201)
      ).body.id as string;
      await http()
        .patch(`${base()}/integrations/${id}`)
        .set('X-Test-Actor', as('gm'))
        .send({ version: 1, status: 'ACTIVE' })
        .expect(200);
      return id;
    };
    pms = await instance('SIM_PMS', [
      'CHECKIN_EVENT',
      'CHECKOUT_EVENT',
      'ROOM_MOVE_EVENT',
      'RESERVATION_READ',
    ]);
    await http()
      .post(`${base()}/integrations/${pms}/mappings/rooms-by-number`)
      .set('X-Test-Actor', as('gm'))
      .expect(200);
    // The hotel's lock system encodes cards only (no mobile keys); its Wi-Fi does both.
    await instance('LOCK_STANDARD', ['KEY_ENCODE', 'KEY_REVOKE']);
    await instance('WIFI_STANDARD', ['WIFI_SESSION_CREATE', 'WIFI_SESSION_REVOKE']);
  });
  afterAll(() => app?.close());

  it('gives nothing to a stay that is not checked in', async () => {
    await send('OWS_RESERVATION', {
      action: 'NEW',
      modifiedAt: '2026-10-01T08:00:00Z',
      reservation: {
        reservationId: `K1-${stamp}`,
        confirmationNo: `CK1-${stamp}`,
        arrivalDate: '2026-10-05',
        departureDate: '2026-10-08',
        adults: 1,
        roomNumber: '504',
        guest: { profileId: `PK1-${stamp}`, firstName: 'Lina', lastName: 'Stone' },
      },
    });
    await drain();
    stayId = (
      await rows<{ stay_id: string }>(
        sql`select stay_id from guest.reservation_references where confirmation_number = ${`CK1-${stamp}`}`,
      )
    )[0]!.stay_id;
    const refused = await http()
      .post(access())
      .set('X-Test-Actor', as('gm'))
      .send({ kind: 'KEY' })
      .expect(409);
    expect(refused.body.code).toBe('guest.access.stay_not_in_house');
  });

  it('issues a key for an in-house stay through the lock connector; the result decides the grant', async () => {
    await fias(`GI|RN504|G#K1-${stamp}|GNStone|GFLina|GD261008|DA261005|TI150000|`);
    await drain();
    expect((await list()).available).toEqual(['KEY', 'WIFI']);
    const unavailable = await http()
      .post(access())
      .set('X-Test-Actor', as('gm'))
      .send({ kind: 'MOBILE_KEY' })
      .expect(409);
    expect(unavailable.body.code).toBe('integration.access.unavailable');
    // A viewer sees, but does not issue.
    await http().get(access()).set('X-Test-Actor', as('viewer')).expect(200);
    await http().post(access()).set('X-Test-Actor', as('viewer')).send({ kind: 'KEY' }).expect(403);

    const key = (
      await http().post(access()).set('X-Test-Actor', as('gm')).send({ kind: 'KEY' }).expect(201)
    ).body as Grant;
    expect(key).toMatchObject({
      kind: 'KEY',
      status: 'REQUESTED',
      roomNumber: '504',
      connectorCode: 'LOCK_STANDARD',
    });
    const encode = await command(key.id, 'issue');
    expect(encode).toMatchObject({
      command_type: 'KEY_ENCODE',
      payload: { grant_id: key.id, room_number: '504' },
    });
    // 14:00 Cairo (UTC+3) on the departure day.
    expect(encode!.payload.valid_until).toBe('2026-10-08T11:00:00.000Z');
    await answer(encode!.id, 'ACKNOWLEDGED');
    expect((await grant(key.id)).status).toBe('ISSUED');
    expect(await eventsOf(key.id)).toEqual(['integration.access.issued']);

    const wifi = (
      await http().post(access()).set('X-Test-Actor', as('gm')).send({ kind: 'WIFI' }).expect(201)
    ).body as Grant;
    await answer((await command(wifi.id, 'issue'))!.id, 'FAILED', 'portal unreachable');
    expect((await grant(wifi.id)).status).toBe('FAILED');
    expect(await eventsOf(wifi.id)).toEqual(['integration.access.failed']);
  });

  it('a room move revokes the old room key, not the Wi-Fi; check-out revokes what is left', async () => {
    const [key] = (await list()).grants.filter((g) => g.kind === 'KEY');
    await fias(`GC|RN505|RO504|G#K1-${stamp}|DA261006|TI100000|`);
    await drain();
    const moved = await grant(key!.id);
    expect(moved).toMatchObject({ status: 'REVOKE_REQUESTED', revokeReason: 'ROOM_MOVED' });
    const revoke = await command(key!.id, 'revoke');
    expect(revoke).toMatchObject({ command_type: 'KEY_REVOKE', payload: { grant_id: key!.id } });
    await answer(revoke!.id, 'ACKNOWLEDGED');
    expect((await grant(key!.id)).status).toBe('REVOKED');
    expect(await eventsOf(key!.id)).toEqual([
      'integration.access.issued',
      'integration.access.revoked',
    ]);

    const newKey = (
      await http().post(access()).set('X-Test-Actor', as('gm')).send({ kind: 'KEY' }).expect(201)
    ).body as Grant;
    expect(newKey.roomNumber).toBe('505');
    await answer((await command(newKey.id, 'issue'))!.id, 'ACKNOWLEDGED');
    const wifi = (
      await http().post(access()).set('X-Test-Actor', as('gm')).send({ kind: 'WIFI' }).expect(201)
    ).body as Grant;
    await answer((await command(wifi.id, 'issue'))!.id, 'ACKNOWLEDGED');

    // Staff revoke the Wi-Fi; the system cannot confirm it — a person must look at it.
    const staffRevoke = await http()
      .post(`${access()}/${wifi.id}/revoke`)
      .set('X-Test-Actor', as('gm'))
      .expect(200);
    expect(staffRevoke.body).toMatchObject({ status: 'REVOKE_REQUESTED', revokeReason: 'STAFF' });
    await answer((await command(wifi.id, 'revoke'))!.id, 'FAILED', 'controller offline');
    expect((await grant(wifi.id)).status).toBe('REVOKE_REQUESTED');
    const exceptions = await rows<{ detail: { reason: string; grant_id: string } }>(
      sql`select detail from integration.integration_exceptions where tenant_id = ${tenantA} and kind = 'CONFLICT' and detail->>'grant_id' = ${wifi.id}`,
    );
    expect(exceptions).toEqual([
      { detail: expect.objectContaining({ reason: 'access_revoke_failed' }) },
    ]);

    await fias(`GO|RN505|G#K1-${stamp}|DA261008|TI110000|`);
    await drain();
    expect(await grant(newKey.id)).toMatchObject({
      status: 'REVOKE_REQUESTED',
      revokeReason: 'CHECKED_OUT',
    });
    await answer((await command(newKey.id, 'revoke'))!.id, 'ACKNOWLEDGED');
    expect((await grant(newKey.id)).status).toBe('REVOKED');
    // The Wi-Fi session that never opened stays FAILED: nothing to revoke, no command sent.
    const failed = (await list()).grants.find((g) => g.kind === 'WIFI' && g.status === 'FAILED');
    expect(failed).toBeDefined();
    expect(await command(failed!.id, 'revoke')).toBeUndefined();
  });

  it('keeps every transition, and the history cannot be rewritten', async () => {
    const key = (await list()).grants.find((g) => g.kind === 'KEY')!;
    const history = await rows<{
      from_status: string | null;
      to_status: string;
      reason: string | null;
    }>(
      sql`select from_status, to_status, reason from integration.access_grant_events where grant_id = ${key.id} order by at, id`,
    );
    expect(history).toEqual([
      { from_status: null, to_status: 'REQUESTED', reason: null },
      { from_status: 'REQUESTED', to_status: 'ISSUED', reason: null },
      { from_status: 'ISSUED', to_status: 'REVOKE_REQUESTED', reason: 'ROOM_MOVED' },
      { from_status: 'REVOKE_REQUESTED', to_status: 'REVOKED', reason: 'ROOM_MOVED' },
    ]);
    await expect(
      db.execute(
        sql`update integration.access_grant_events set reason = 'X' where grant_id = ${key.id}`,
      ),
    ).rejects.toThrow();
  });

  it('another hotel sees none of it', async () => {
    await http().get(access()).set('X-Test-Actor', as('other', tenantB)).expect(404);
    await http()
      .post(access())
      .set('X-Test-Actor', as('other', tenantB))
      .send({ kind: 'KEY' })
      .expect(404);
  });
});
