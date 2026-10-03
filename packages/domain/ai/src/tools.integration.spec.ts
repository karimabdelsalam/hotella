import 'reflect-metadata';
import { Global, type INestApplication, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { CATALOG_API, type CatalogPublicApi } from '@hotella/domain-catalog/public';
import { CatalogModule } from '@hotella/domain-catalog';
import { CommunicationsModule } from '@hotella/domain-communications';
import {
  COMMUNICATIONS_API,
  type CommunicationsPublicApi,
} from '@hotella/domain-communications/public';
import { GuestModule } from '@hotella/domain-guest';
import { GUEST_API, GUEST_SESSION_HEADER, type GuestPublicApi } from '@hotella/domain-guest/public';
import { IDENTITY_API } from '@hotella/domain-identity/public';
import { IntegrationsModule } from '@hotella/domain-integrations';
import { OperationsModule } from '@hotella/domain-operations';
import { OrganizationModule } from '@hotella/domain-organization';
import { AuditModule } from '@hotella/platform-audit';
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
} from '@hotella/platform-database';
import { EventsModule } from '@hotella/platform-events';
import { FeatureFlagService, FeatureFlagsModule } from '@hotella/platform-flags';
import { HttpConventionsModule } from '@hotella/platform-http';
import { I18nModule } from '@hotella/platform-i18n';
import { ManifestModule } from '@hotella/platform-manifest';
import { ObservabilityModule, RequestContext } from '@hotella/platform-observability';
import { EnvSecretProvider, SecretsModule } from '@hotella/platform-secrets';
import { SettingsModule } from '@hotella/platform-settings';
import { infraSkipReason, needsInfra, readTestInfra } from '@hotella/platform-testing';
import { ZodValidationPipe } from 'nestjs-zod';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AiModule } from './ai.module';
import {
  AI_ACTION_APPROVAL,
  type ExecutionHandle,
  ToolExecutor,
} from './application/tools/executor';
import { ProposalSettler } from './application/tools/proposal-settler';
import { ToolRegistry } from './application/tools/registry';
import { killSwitch } from './domain/settings';
import { AiRepositories } from './infrastructure/repositories';
import { AI_MANIFEST } from './manifest';

const admin = JSON.stringify({ type: 'USER', id: 'admin', tenantId: null, isPlatformAdmin: true });
const user = (id: string, tenantId: string) =>
  JSON.stringify({ type: 'USER', id, tenantId, isPlatformAdmin: false });
const stamp = Date.now().toString(36).toUpperCase();
const CONCIERGE_TOOLS = AI_MANIFEST.aiTools.map((t) => t.code);

@Global()
@Module({
  providers: [
    {
      provide: IDENTITY_API,
      useValue: {
        getStaffMember: async () => null,
        usersWithPermission: async () => [],
        usersWithRole: async () => [],
        getStaffContact: async () => null,
      },
    },
  ],
  exports: [IDENTITY_API],
})
class FakeIdentityModule {}

interface Hotel {
  tenantId: string;
  propertyId: string;
  stayId: string;
  guestId: string;
}

describe.skipIf(needsInfra())(`AI tools through the ActionGate (${infraSkipReason()})`, () => {
  const url = readTestInfra().databaseUrl!;
  const gmId = newId();
  const approverId = newId();
  const STAFF = [
    'org.property.read',
    'org.property.manage',
    'org.location.manage',
    'org.department.manage',
    'catalog.read',
    'catalog.manage',
    'catalog.publish',
    'request.read',
    'request.manage',
    'approval.read',
    'approval.decide',
  ];
  let app: INestApplication;
  let db: Database;
  let executor: ToolExecutor;
  let catalog: CatalogPublicApi;
  let a: Hotel;
  let b: Hotel;
  let conversationId: string;
  const http = () => request(app.getHttpServer());
  const flags = new Map<string, boolean>();

  const createHotel = async (code: string): Promise<Hotel> => {
    const tenantId = (
      await http()
        .post('/tenants')
        .set('X-Test-Actor', admin)
        .send({ code, name: code })
        .expect(201)
    ).body.id as string;
    const gm = user(gmId, tenantId);
    const propertyId = (
      await http()
        .post('/properties')
        .set('X-Test-Actor', gm)
        .send({ code: 'AIT', name: 'Nile View', timezone: 'Africa/Cairo', currency: 'EGP' })
        .expect(201)
    ).body.id as string;
    const base = `/properties/${propertyId}`;
    for (const [dept, name] of [
      ['HK', 'Housekeeping'],
      ['ENG', 'Engineering'],
      ['FO', 'Front office'],
    ])
      await http()
        .post(`${base}/departments`)
        .set('X-Test-Actor', gm)
        .send({ code: dept, translations: [{ locale: 'en', name }] })
        .expect(201);
    const tree = await http().get(`${base}/locations`).set('X-Test-Actor', gm).expect(200);
    const root = Array.isArray(tree.body) ? tree.body[0].id : tree.body.id;
    const roomId = (
      await http()
        .post(`${base}/rooms`)
        .set('X-Test-Actor', gm)
        .send({ parentId: root, roomNumber: '504' })
        .expect(201)
    ).body.locationId as string;
    await http().post(`${base}/catalog/starter`).set('X-Test-Actor', gm).send({}).expect(200);
    // An in-house stay as the guest context projects it from the PMS.
    const guestId = newId();
    const stayId = newId();
    const today = new Date().toISOString().slice(0, 10);
    const departure = new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 10);
    await db.execute(sql`insert into guest.guests (id, tenant_id, given_name, family_name, primary_locale)
      values (${guestId}, ${tenantId}, 'Mona', 'Delta', 'ar')`);
    await db.execute(sql`insert into guest.stays (id, tenant_id, property_id, status, primary_guest_id, expected_arrival, expected_departure, actual_checkin_at, last_pms_event_at)
      values (${stayId}, ${tenantId}, ${propertyId}, 'IN_HOUSE', ${guestId}, ${today}, ${departure}, now(), now())`);
    await db.execute(sql`insert into guest.stay_party_members (id, tenant_id, stay_id, guest_id, role, joined_at)
      values (${newId()}, ${tenantId}, ${stayId}, ${guestId}, 'PRIMARY', now())`);
    await db.execute(sql`insert into guest.room_assignments (id, tenant_id, property_id, stay_id, room_id, assigned_at, reason)
      values (${newId()}, ${tenantId}, ${propertyId}, ${stayId}, ${roomId}, now(), 'INITIAL')`);
    return { tenantId, propertyId, stayId, guestId };
  };

  const start = (hotel: Hotel, opts: { autoMedium?: boolean; tools?: string[] } = {}) =>
    executor.start({
      tenantId: hotel.tenantId,
      propertyId: hotel.propertyId,
      agentCode: 'guest_concierge',
      tools: opts.tools ?? CONCIERGE_TOOLS,
      autonomy: {
        autoMediumTools: opts.autoMedium ? ['operations.create_service_request'] : [],
      },
      locale: 'ar',
      guest: { guestId: hotel.guestId, stayId: hotel.stayId },
      conversationId: hotel === a ? conversationId : null,
      trigger: 'MESSAGE',
      on: { type: 'GUEST', id: hotel.guestId },
    });
  const invoke = (handle: ExecutionHandle, tool: string, args: unknown = {}, reason?: string) =>
    app
      .get(RequestContext)
      .run({ correlation_id: `ai-tools-${stamp}` }, () =>
        executor.invoke(handle, { tool, arguments: args, reason: reason ?? null }),
      );

  beforeAll(async () => {
    await runMigrations(url);
    const env = {
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      DATABASE_URL: await applicationRoleUrl(url, 'hotella_app_ai_tools'),
      VALKEY_URL: 'redis://127.0.0.1:1',
      PUBLIC_BASE_URL: 'https://guest.example.test',
    };
    const ref = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ env }),
        ObservabilityModule.forRoot(),
        I18nModule.forRoot(),
        SecretsModule.forRoot({
          providers: [new EnvSecretProvider({ COMMS_OTP_HMAC_KEY: 'test-otp-key' })],
        }),
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
            useValue: new StaticPermissionResolver({ [gmId]: STAFF, [approverId]: STAFF }),
          },
          propertyVerifier: OrganizationModule.propertyVerifier(),
          stages: [IntegrationsModule.capabilityStage(), ...AiModule.gateStages()],
        }),
        OrganizationModule,
        IntegrationsModule,
        GuestModule,
        FakeIdentityModule,
        OperationsModule,
        CommunicationsModule,
        CatalogModule,
        AiModule,
      ],
    })
      .overrideProvider(FeatureFlagService)
      .useValue({ isEnabled: async (key: string) => flags.get(key) ?? false })
      .compile();
    app = ref.createNestApplication({ logger: false, rawBody: true });
    app.useGlobalPipes(new ZodValidationPipe());
    await app.init();
    db = app.get(DATABASE);
    executor = app.get(ToolExecutor);
    catalog = app.get(CATALOG_API);
    a = await createHotel(`ai-tools-a-${stamp}`);
    // The guest opens the stay conversation on the guest web (CHAT scope).
    const guests = app.get<GuestPublicApi>(GUEST_API);
    const grant = await guests.issueGrant({
      tenantId: a.tenantId,
      propertyId: a.propertyId,
      stayId: a.stayId,
      guestId: a.guestId,
      via: 'STAFF',
      actor: { type: 'SYSTEM', id: null },
      reason: 'test',
    });
    const token = (await guests.openGuestSession(a.tenantId, grant.id, 'test')).token;
    await http()
      .post('/guest/conversation/messages')
      .set(GUEST_SESSION_HEADER, token)
      .send({ body: 'محتاجة فوط زيادة' })
      .expect(201);
    conversationId = (
      await http().get('/guest/conversation').set(GUEST_SESSION_HEADER, token).expect(200)
    ).body.conversation.id;
    b = await createHotel(`ai-tools-b-${stamp}`);
  });
  afterAll(() => app?.close());

  it('declares every registered tool in the manifest with the same risk and permission', () => {
    const registry = app.get(ToolRegistry);
    expect(registry.all().map((t) => t.code)).toEqual([...CONCIERGE_TOOLS].sort());
    for (const declared of AI_MANIFEST.aiTools) {
      const tool = registry.get(declared.code)!;
      expect([tool.risk, tool.requiredPermission]).toEqual([
        declared.risk,
        declared.requiredPermission,
      ]);
    }
    const [fn] = registry.forModel(['operations.create_service_request']);
    expect(fn!.name).toBe('operations__create_service_request');
    expect(fn!.parameters).toMatchObject({
      type: 'object',
      required: expect.arrayContaining(['service_code']),
    });
    expect(registry.fromModelName(fn!.name)?.code).toBe('operations.create_service_request');
  });

  it('reads the stay, the catalog and open requests for the execution guest only', async () => {
    const handle = await start(a);
    const stay = await invoke(handle, 'guest.get_current_stay');
    expect(stay).toMatchObject({
      status: 'OK',
      result: { status: 'IN_HOUSE', room_number: '504' },
    });
    const services = await invoke(handle, 'catalog.list_services');
    expect(services.status).toBe('OK');
    const codes = (services as { result: Array<{ code: string }> }).result.map((s) => s.code);
    expect(codes).toContain('EXTRA_TOWELS');
    expect(await invoke(handle, 'operations.find_open_requests')).toEqual({
      status: 'OK',
      result: [],
    });
  });

  it('creates a request on its own only when the agent version allows that MEDIUM tool', async () => {
    const auto = await start(a, { autoMedium: true });
    const created = await invoke(auto, 'operations.create_service_request', {
      service_code: 'EXTRA_TOWELS',
      fields: { quantity: 2 },
    });
    expect(created).toMatchObject({ status: 'OK', result: { status: 'OPEN' } });
    const requestId = (created as { result: { request_id: string } }).result.request_id;
    const row = await catalog.getServiceRequest(a.tenantId, requestId);
    expect(row).toMatchObject({ source: 'AI', locale: 'ar', guestId: a.guestId });
    // The audit names the AI agent (the execution) as the actor.
    const audit = (
      await db.execute(
        sql`select actor_type, actor_id from audit.audit_log where tenant_id = ${a.tenantId} and action = 'catalog.request.create' and entity_id = ${requestId}`,
      )
    ).rows[0] as { actor_type: string; actor_id: string };
    expect(audit).toEqual({ actor_type: 'AI_AGENT', actor_id: auto.id });

    // Without autonomy the same call becomes a proposal for a person.
    const careful = await start(a);
    const proposed = await invoke(careful, 'operations.create_service_request', {
      service_code: 'EXTRA_TOWELS',
      fields: { quantity: 1 },
    });
    expect(proposed.status).toBe('PROPOSED');
  });

  it('a HIGH-risk cancellation waits for a person; approving runs it as proposed', async () => {
    const handle = await start(a);
    const requests = await catalog.serviceRequestsOfStay(a.tenantId, a.stayId);
    const target = requests.find((r) => r.status === 'OPEN')!;
    const outcome = await invoke(
      handle,
      'operations.cancel_service_request',
      { request_id: target.id, reason: 'الضيفة لم تعد تحتاجها' },
      'The guest said she no longer needs them',
    );
    expect(outcome.status).toBe('PROPOSED');
    const { proposalId, approvalId } = outcome as { proposalId: string; approvalId: string };
    expect((await catalog.getServiceRequest(a.tenantId, target.id))!.status).toBe('OPEN');
    const approval = (
      await http()
        .get(`/properties/${a.propertyId}/approvals/${approvalId}`)
        .set('X-Test-Actor', user(approverId, a.tenantId))
        .expect(200)
    ).body;
    expect(approval).toMatchObject({
      kind: AI_ACTION_APPROVAL,
      riskLevel: 'HIGH',
      requestedBy: { type: 'AI_AGENT', id: handle.id },
      payload: { tool: 'operations.cancel_service_request' },
    });
    await http()
      .post(`/properties/${a.propertyId}/approvals/${approvalId}/decision`)
      .set('X-Test-Actor', user(approverId, a.tenantId))
      .send({ decision: 'APPROVE', reason: 'ok' })
      .expect(200);
    expect((await catalog.getServiceRequest(a.tenantId, target.id))!.status).toBe('CANCELLED');
    const proposal = await app.get(AiRepositories).proposal({ tenantId: a.tenantId }, proposalId);
    expect(proposal).toMatchObject({ status: 'EXECUTED', result: { status: 'CANCELLED' } });
  });

  it('a rejected proposal is closed and nothing happens', async () => {
    const auto = await start(a, { autoMedium: true });
    const created = (await invoke(auto, 'operations.create_service_request', {
      service_code: 'EXTRA_TOWELS',
      fields: { quantity: 3 },
    })) as { result: { request_id: string } };
    const outcome = (await invoke(auto, 'operations.cancel_service_request', {
      request_id: created.result.request_id,
      reason: 'x',
    })) as { status: string; proposalId: string; approvalId: string };
    expect(outcome.status).toBe('PROPOSED');
    await http()
      .post(`/properties/${a.propertyId}/approvals/${outcome.approvalId}/decision`)
      .set('X-Test-Actor', user(approverId, a.tenantId))
      .send({ decision: 'REJECT', reason: 'still needed' })
      .expect(200);
    // The worker consumer of ops.approval.decided closes it (idempotently).
    const settler = app.get(ProposalSettler);
    expect(await settler.settle(a.tenantId, outcome.approvalId, 'REJECTED')).toBe(true);
    expect(await settler.settle(a.tenantId, outcome.approvalId, 'REJECTED')).toBe(false);
    const proposal = await app
      .get(AiRepositories)
      .proposal({ tenantId: a.tenantId }, outcome.proposalId);
    expect(proposal!.status).toBe('REJECTED');
    expect(
      (await catalog.getServiceRequest(a.tenantId, created.result.request_id))!.status,
    ).not.toBe('CANCELLED');
  });

  it('refuses tools outside the agent, bad arguments, other guests, CRITICAL tools and kill switches', async () => {
    const limited = await start(a, { tools: ['guest.get_current_stay'] });
    expect(await invoke(limited, 'catalog.list_services')).toEqual({
      status: 'REFUSED',
      reason: 'TOOL_NOT_ALLOWED',
    });
    const handle = await start(a, { autoMedium: true });
    const bad = await invoke(handle, 'operations.create_service_request', { fields: 'nope' });
    expect(bad).toMatchObject({ status: 'ERROR', code: 'ai.tool.invalid_arguments' });
    expect((bad.status === 'ERROR' ? (bad.issues ?? []) : []).join(' ')).toContain('service_code');

    // Hotel B's request cannot be touched from hotel A's execution, not even proposed.
    const other = await start(b, { autoMedium: true });
    const theirs = (await invoke(other, 'operations.create_service_request', {
      service_code: 'EXTRA_TOWELS',
      fields: { quantity: 1 },
    })) as { result: { request_id: string } };
    expect(
      await invoke(handle, 'operations.cancel_service_request', {
        request_id: theirs.result.request_id,
        reason: 'x',
      }),
    ).toEqual({ status: 'ERROR', code: 'catalog.request.not_found' });

    // A CRITICAL tool is refused by policy, whatever the agent may hold.
    app.get(ToolRegistry).register({
      code: 'test.wipe_everything',
      description: 'x',
      risk: 'CRITICAL',
      requiredPermission: 'request.manage',
      input: z.object({}),
      handle: async () => 'done',
    });
    const reckless = await start(a, { tools: ['test.wipe_everything'] });
    expect(await invoke(reckless, 'test.wipe_everything')).toEqual({
      status: 'REFUSED',
      reason: 'CRITICAL_NOT_FOR_AI',
    });

    flags.set(killSwitch.tool('guest.get_current_stay'), true);
    expect(await invoke(handle, 'guest.get_current_stay')).toEqual({
      status: 'REFUSED',
      reason: 'DISABLED',
    });
    flags.delete(killSwitch.tool('guest.get_current_stay'));
    flags.set(killSwitch.autoActions, true);
    expect(
      (
        await invoke(handle, 'operations.create_service_request', {
          service_code: 'EXTRA_TOWELS',
          fields: { quantity: 1 },
        })
      ).status,
    ).toBe('PROPOSED');
    flags.delete(killSwitch.autoActions);
  });

  it('an AI actor outside a cleared tool call is refused by the gate', async () => {
    const actors = app.get(ActorStore);
    const attempt = app.get(RequestContext).run({ tenant_id: a.tenantId }, async () => {
      actors.set({ type: 'AI_AGENT', id: newId(), tenantId: a.tenantId, isPlatformAdmin: false });
      return catalog.cancelServiceRequest(a.tenantId, a.propertyId, newId(), 'x');
    });
    await expect(attempt).rejects.toMatchObject({ code: 'platform.forbidden' });
  });

  it('answers in the conversation until staff take it over', async () => {
    const handle = await start(a);
    const sent = await invoke(handle, 'communication.send_message', {
      body: 'حاضر، الفوط في الطريق إليكِ.',
    });
    expect(sent).toMatchObject({ status: 'OK' });
    const [message] = (
      await db.execute(
        sql`select sender_type, sender_ref from comms.messages where tenant_id = ${a.tenantId} and conversation_id = ${conversationId} and direction = 'OUTBOUND' order by id desc limit 1`,
      )
    ).rows as Array<{ sender_type: string; sender_ref: string }>;
    expect(message).toEqual({ sender_type: 'AI', sender_ref: 'guest_concierge' });
    await app.get<CommunicationsPublicApi>(COMMUNICATIONS_API).handOff({
      tenantId: a.tenantId,
      conversationId,
      reason: 'GUEST_ASKED_FOR_PERSON',
    });
    expect(await invoke(handle, 'communication.send_message', { body: 'hello again' })).toEqual({
      status: 'ERROR',
      code: 'comms.conversation.handed_off',
    });
    // A guest-less execution cannot use guest tools.
    expect(await invoke(await start(b), 'communication.send_message', { body: 'x' })).toEqual({
      status: 'ERROR',
      code: 'ai.tool.context_missing',
    });
  });

  it('records every call as an append-only step, isolated per tenant', async () => {
    const handle = await start(a);
    await invoke(handle, 'guest.get_current_stay');
    await invoke(handle, 'catalog.list_services');
    await executor.finish(handle, 'COMPLETED');
    const steps = await app.get(AiRepositories).steps({ tenantId: a.tenantId }, handle.id);
    expect(steps.map((s) => [s.type, s.name, s.outcome])).toEqual([
      ['TOOL_CALL', 'guest.get_current_stay', 'OK'],
      ['TOOL_CALL', 'catalog.list_services', 'OK'],
    ]);
    const refused = await db
      .execute(sql`update ai.execution_steps set outcome = 'X' where id = ${steps[0]!.id}`)
      .then(
        () => '',
        (e: Error) => String((e.cause as Error | undefined)?.message ?? e.message),
      );
    expect(refused).toMatch(/append-only/);
    expect(await app.get(AiRepositories).steps({ tenantId: b.tenantId }, handle.id)).toEqual([]);
    // Row-level security hides another tenant's proposals even without a filter.
    const leaked = await db.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.tenant_id', ${b.tenantId}, true)`);
      return (
        await tx.execute(
          sql`select count(*)::int as n from ai.action_proposals where tenant_id = ${a.tenantId}`,
        )
      ).rows[0] as { n: number };
    });
    expect(leaked.n).toBe(0);
  });
});
