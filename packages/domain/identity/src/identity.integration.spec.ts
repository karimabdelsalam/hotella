import 'reflect-metadata';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ZodValidationPipe } from 'nestjs-zod';
import { Client } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OrganizationModule } from '@hotella/domain-organization';
import { AuditModule } from '@hotella/platform-audit';
import { SettingsModule } from '@hotella/platform-settings';
import { AuthModule } from '@hotella/platform-auth';
import { ConfigModule } from '@hotella/platform-config';
import { sql } from 'drizzle-orm';
import {
  applicationRoleUrl,
  DATABASE,
  type Database,
  DatabaseModule,
  runMigrations,
  TransactionRunner,
} from '@hotella/platform-database';
import { EventsModule } from '@hotella/platform-events';
import { FeatureFlagsModule } from '@hotella/platform-flags';
import { HttpConventionsModule, KV_STORE, MemoryKeyValueStore } from '@hotella/platform-http';
import { I18nModule, I18nService } from '@hotella/platform-i18n';
import { defineManifest, ManifestModule, ManifestRegistry } from '@hotella/platform-manifest';
import { LOGGER, ObservabilityModule } from '@hotella/platform-observability';
import { SecretsModule } from '@hotella/platform-secrets';
import { infraSkipReason, needsInfra, readTestInfra } from '@hotella/platform-testing';
import { IdentityBootstrapService } from './application/bootstrap.service';
import { IdentityCatalogService } from './application/catalog.service';
import { MembershipPermissionResolver } from './auth/permission-resolver';
import { IdentityRepositories } from './infrastructure/repositories';
import { totp } from './domain/totp';
import { IdentityCoreModule } from './identity-core.module';
import { IdentityModule, identityAuthOptions, identityLocalePreferences } from './identity.module';

/** Rate limiting is exercised explicitly in one test; elsewhere the many logins of this suite must not trip it. */
class ToggleRateLimitStore extends MemoryKeyValueStore {
  enforce = false;
  override async incrementWindow(key: string, windowSeconds: number) {
    if (!this.enforce) return { count: 1, resetInSeconds: windowSeconds };
    return super.incrementWindow(key, windowSeconds);
  }
}

const stamp = Date.now().toString(36).toUpperCase();
const ADMIN = {
  email: `root-${stamp.toLowerCase()}@planova.example`,
  password: 'platform admin passphrase 1',
};

describe.skipIf(needsInfra())(`Identity & Access against PostgreSQL (${infraSkipReason()})`, () => {
  const url = readTestInfra().databaseUrl!;
  const store = new ToggleRateLimitStore();
  let appUrl: string;
  let app: INestApplication;
  const api = () => request(app.getHttpServer());
  const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });
  let adminToken: string;
  let tenantId: string;
  let otherTenantId: string;
  let tenantCode: string;
  let propA: string;
  let propB: string;
  let foreignProp: string;
  let gm: { userId: string; access: string; refresh: string };

  beforeAll(async () => {
    await runMigrations(url);
    // Ordinary role (superusers bypass row-level security); one role per suite since suites run in parallel.
    appUrl = await applicationRoleUrl(url, 'hotella_app_identity');
    const ref = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          env: {
            NODE_ENV: 'test',
            LOG_LEVEL: 'silent',
            DATABASE_URL: appUrl,
            VALKEY_URL: 'redis://127.0.0.1:1',
            IAM_LOGIN_MAX_ATTEMPTS: '5',
          },
        }),
        ObservabilityModule.forRoot(),
        SecretsModule.forRoot({ providers: [] }),
        I18nModule.forRoot({ preferences: identityLocalePreferences() }),
        HttpConventionsModule.forRoot({ store: 'memory' }),
        DatabaseModule.forRoot(),
        EventsModule.forRoot(),
        FeatureFlagsModule,
        ManifestModule.forRoot(),
        AuditModule,
        SettingsModule,
        IdentityCoreModule,
        AuthModule.forRoot({
          ...identityAuthOptions(),
          propertyVerifier: OrganizationModule.propertyVerifier(),
        }),
        OrganizationModule,
        IdentityModule,
      ],
    })
      .overrideProvider(KV_STORE)
      .useValue(store)
      .compile();
    app = ref.createNestApplication({ logger: false });
    app.useGlobalPipes(new ZodValidationPipe());
    await app.init();
    await app.get(IdentityCatalogService).sync();
    await app.get(IdentityBootstrapService).createPlatformAdmin({ ...ADMIN, givenName: 'Root' });
  });
  afterAll(() => app?.close());

  it('platform admin signs in; wrong password and unknown e-mail get the same generic 401', async () => {
    const wrong = await api()
      .post('/auth/login')
      .send({ email: ADMIN.email, password: 'nope nope nope' })
      .expect(401);
    const unknown = await api()
      .post('/auth/login')
      .send({ email: `ghost-${stamp}@x.example`, password: 'nope nope nope' })
      .expect(401);
    expect(wrong.body.code).toBe('iam.auth.invalid_credentials');
    expect(unknown.body.code).toBe(wrong.body.code);
    expect(unknown.body.detail).toBe(wrong.body.detail);
    const ok = await api().post('/auth/login').send(ADMIN).expect(200);
    expect(ok.body).toMatchObject({ mfaRequired: false, tokenType: 'Bearer', expiresIn: 900 });
    expect(ok.body.refreshToken).toMatch(/^rt_/);
    adminToken = ok.body.accessToken;
    const me = await api().get('/me').set(bearer(adminToken)).expect(200);
    expect(me.body.user).toMatchObject({ isPlatformAdmin: true, tenantId: null });
    expect(me.body.permissions).toContain('org.tenant.manage');
    // Spec §64: no standing access beyond tenant administration
    expect(me.body.permissions).not.toContain('support.access.approve');
  });

  it('a process that loads part of the platform never strips the grants of modules it does not load', async () => {
    const repo = app.get(IdentityRepositories);
    const sync = (registry: ManifestRegistry) =>
      new IdentityCatalogService(
        repo,
        registry,
        app.get(I18nService),
        app.get(TransactionRunner),
        app.get(MembershipPermissionResolver),
        app.get(LOGGER),
      ).sync();
    const adminGrants = async () => {
      const role = await repo.systemRoleByCode('PLATFORM_ADMIN');
      return (await repo.rolePermissionCodes([role!.id])).get(role!.id) ?? [];
    };
    // The API loads the integration context too…
    const full = new ManifestRegistry();
    for (const m of app.get(ManifestRegistry).all()) full.register(m);
    full.register(
      defineManifest({
        code: 'integration',
        schema: 'integration',
        description: 'stand-in for the integration context',
        permissions: [
          'integration.read',
          'integration.configure',
          'integration.mapping.confirm',
          'integration.replay',
          'integration.reconcile',
          'integration.webhook.manage',
        ].map((code) => ({ code, descriptionKey: 'x', risk: 'LOW' as const })),
      }),
    );
    await sync(full);
    expect(await adminGrants()).toContain('integration.read');
    // …then the admin CLI (organization + identity only) syncs: the integration grant must survive (pilot defect).
    await sync(app.get(ManifestRegistry));
    expect(await adminGrants()).toContain('integration.read');
    expect(await adminGrants()).toContain('org.tenant.manage');
  });

  it('platform admin onboards a tenant with two properties (and a second tenant)', async () => {
    tenantCode = `NILE_${stamp}`;
    tenantId = (
      await api()
        .post('/tenants')
        .set(bearer(adminToken))
        .send({ code: tenantCode, name: 'Nile' })
        .expect(201)
    ).body.id;
    otherTenantId = (
      await api()
        .post('/tenants')
        .set(bearer(adminToken))
        .send({ code: `RED_${stamp}`, name: 'Red' })
        .expect(201)
    ).body.id;
    const prop = (code: string, t: string) =>
      api()
        .post('/properties')
        .set(bearer(adminToken))
        .send({ tenantId: t, code, name: code, timezone: 'Africa/Cairo', currency: 'EGP' })
        .expect(201)
        .then((r) => r.body.id as string);
    propA = await prop('CAI', tenantId);
    propB = await prop('LXR', tenantId);
    foreignProp = await prop('HRG', otherTenantId);
  });

  it('invites a user with different roles per property; the invitation sets the first password once', async () => {
    const created = await api()
      .post(`/tenants/${tenantId}/users`)
      .set(bearer(adminToken))
      .send({
        email: `GM-${stamp}@Nile.example`,
        givenName: 'Mona',
        localePref: 'ar',
        memberships: [
          { propertyId: propA, roleCodes: ['GENERAL_MANAGER'] },
          { propertyId: propB, roleCodes: ['ROOM_ATTENDANT'] },
        ],
      })
      .expect(201);
    expect(created.body.user).toMatchObject({
      status: 'INVITED',
      email: `gm-${stamp.toLowerCase()}@nile.example`,
    });
    expect(created.body.memberships).toHaveLength(2);
    const token = created.body.invitation.token as string;
    expect(token).toMatch(/^inv_/);
    // the invited user cannot sign in yet
    await api()
      .post('/auth/login')
      .send({ tenantCode, email: `gm-${stamp}@nile.example`, password: 'whatever whatever' })
      .expect(401);
    const weak = await api()
      .post('/auth/invitations/accept?lang=ar')
      .send({ token, password: 'short' })
      .expect(422);
    expect(weak.body).toMatchObject({ code: 'iam.password.too_short', params: { min: 12 } });
    expect(weak.body.detail).toBe('يجب ألا تقل كلمة المرور عن 12 حرفًا.');
    // the failed attempt rolled back: the same token still works once
    await api()
      .post('/auth/invitations/accept')
      .send({ token, password: 'nile palace sunrise' })
      .expect(200);
    await api()
      .post('/auth/invitations/accept')
      .send({ token, password: 'nile palace sunrise' })
      .expect(400);
    gm = {
      userId: created.body.user.id,
      ...(await login(`gm-${stamp}@nile.example`, 'nile palace sunrise')),
    };
  });

  it('one user, different permissions per property, no leakage across properties or tenants (Phase 1 acceptance)', async () => {
    // GENERAL_MANAGER at A → may edit A
    await api()
      .patch(`/properties/${propA}`)
      .set(bearer(gm.access))
      .send({ version: 1, name: 'Nile Palace Cairo' })
      .expect(200);
    // ROOM_ATTENDANT at B → may read B but not edit it
    await api().get(`/properties/${propB}`).set(bearer(gm.access)).expect(200);
    const denied = await api()
      .patch(`/properties/${propB}`)
      .set(bearer(gm.access))
      .send({ version: 1, name: 'x' })
      .expect(403);
    expect(denied.body.code).toBe('platform.forbidden');
    // another tenant's property is not found, never forbidden
    await api().get(`/properties/${foreignProp}`).set(bearer(gm.access)).expect(404);
    await api().get(`/tenants/${otherTenantId}/users`).set(bearer(gm.access)).expect(404);
    // tenant-level actions need a tenant-wide membership
    await api().get(`/tenants/${tenantId}/users`).set(bearer(gm.access)).expect(403);
  });

  it('/me lists memberships with role names in the user preference language and permissions per property', async () => {
    const me = await api().get('/me').set(bearer(gm.access)).expect(200);
    expect(me.headers['content-language']).toBe('ar');
    const byProp = new Map(
      me.body.memberships.map((m: { propertyId: string }) => [m.propertyId, m]),
    );
    expect(byProp.get(propA)).toMatchObject({
      roles: [{ code: 'GENERAL_MANAGER', name: 'المدير العام' }],
    });
    expect((byProp.get(propA) as { permissions: string[] }).permissions).toContain(
      'org.property.manage',
    );
    expect((byProp.get(propB) as { permissions: string[] }).permissions).toEqual([
      'org.property.read',
    ]);
    expect(me.body.permissions).toEqual([]); // nothing tenant-wide
    const en = await api().get('/me?lang=en').set(bearer(gm.access)).expect(200);
    expect(
      en.body.memberships.find((m: { propertyId: string }) => m.propertyId === propA).roles[0].name,
    ).toBe('General manager');
  });

  it('delegation: a property manager grants only within the property and only permissions they hold', async () => {
    const staff = await api()
      .post(`/tenants/${tenantId}/users`)
      .set(bearer(adminToken))
      .send({ email: `ra-${stamp}@nile.example`, givenName: 'Ali' })
      .expect(201);
    const uid = staff.body.user.id as string;
    // GM at A grants ROOM_ATTENDANT at A
    const m = await api()
      .post(`/tenants/${tenantId}/users/${uid}/memberships`)
      .set(bearer(gm.access))
      .send({ propertyId: propA, roleCodes: ['ROOM_ATTENDANT'] })
      .expect(201);
    // …but not at B (no iam.membership.manage there) and not tenant-wide
    await api()
      .post(`/tenants/${tenantId}/users/${uid}/memberships`)
      .set(bearer(gm.access))
      .send({ propertyId: propB, roleCodes: ['ROOM_ATTENDANT'] })
      .expect(403);
    await api()
      .post(`/tenants/${tenantId}/users/${uid}/memberships`)
      .set(bearer(gm.access))
      .send({ roleCodes: ['ROOM_ATTENDANT'] })
      .expect(403);
    // platform roles are never assignable through memberships
    const reserved = await api()
      .put(`/tenants/${tenantId}/memberships/${m.body.id}/roles`)
      .set(bearer(adminToken))
      .send({ roleCodes: ['PLATFORM_ADMIN'] })
      .expect(422);
    expect(reserved.body.code).toBe('iam.role.not_assignable');
    // a tenant role carrying a permission the GM lacks at A cannot be granted by the GM
    await api()
      .post(`/tenants/${tenantId}/roles`)
      .set(bearer(adminToken))
      .send({
        code: 'NIGHT_AUDITOR',
        translations: [
          { locale: 'en', name: 'Night auditor' },
          { locale: 'ar', name: 'مدقق ليلي' },
        ],
        permissions: ['org.property.read', 'support.access.request'],
      })
      .expect(201);
    const escalate = await api()
      .put(`/tenants/${tenantId}/memberships/${m.body.id}/roles`)
      .set(bearer(gm.access))
      .send({ roleCodes: ['NIGHT_AUDITOR'] })
      .expect(403);
    expect(escalate.body.code).toBe('iam.role.cannot_delegate');
    // system roles are immutable
    const roles = await api().get(`/tenants/${tenantId}/roles`).set(bearer(adminToken)).expect(200);
    const gmRole = roles.body.find((r: { code: string }) => r.code === 'GENERAL_MANAGER');
    expect(roles.body.map((r: { code: string }) => r.code)).not.toContain('PLATFORM_ADMIN');
    await api()
      .put(`/tenants/${tenantId}/roles/${gmRole.id}/permissions`)
      .set(bearer(adminToken))
      .send({ permissions: ['org.property.read'] })
      .expect(422);
  });

  it('mutations leave an audit trail with actor, correlation id and no secrets (Spec §68)', async () => {
    await api()
      .patch(`/properties/${propA}`)
      .set(bearer(gm.access))
      .set('X-Correlation-Id', `corr-audit-${stamp}`)
      .send({ version: 2, name: 'Nile Palace' })
      .expect(200);
    // GENERAL_MANAGER at A may read A's audit trail, not the whole tenant's
    const trail = await api()
      .get(`/audit?propertyId=${propA}&limit=100`)
      .set(bearer(gm.access))
      .expect(200);
    const update = trail.body.data.find(
      (e: { correlationId: string }) => e.correlationId === `corr-audit-${stamp}`,
    );
    expect(update).toMatchObject({
      action: 'org.property.update',
      entityType: 'property',
      entityId: propA,
      tenantId,
      propertyId: propA,
      actorType: 'USER',
      actorId: gm.userId,
      before: { name: 'Nile Palace Cairo' },
      after: { name: 'Nile Palace' },
    });
    const actions = trail.body.data.map((e: { action: string }) => e.action);
    expect(actions).toEqual(
      expect.arrayContaining(['iam.membership.grant', 'org.property.update']),
    );
    await api().get('/audit').set(bearer(gm.access)).expect(403);
    // platform administrators have no standing access to the hotel's audit trail
    await api().get(`/audit?tenantId=${tenantId}`).set(bearer(adminToken)).expect(403);
    // the full tenant trail (read as the database would) never contains credential material
    const all = await api()
      .get(`/audit?propertyId=${propA}&action=iam.&limit=100`)
      .set(bearer(gm.access))
      .expect(200);
    expect(JSON.stringify(all.body)).not.toMatch(/argon2|inv_|rt_/);
  });

  it('configuration inherits platform → tenant → property, respects scopes and is audited (Spec §73)', async () => {
    const key = 'org.property.checkout_time';
    const defs = await api().get('/config/definitions').set(bearer(adminToken)).expect(200);
    expect(defs.body.map((d: { key: string }) => d.key)).toEqual(
      expect.arrayContaining([key, 'iam.password.min_length']),
    );
    await api()
      .put(`/config/values/${key}`)
      .set(bearer(adminToken))
      .send({ scope: 'PLATFORM', value: '11:00' })
      .expect(200);
    // GENERAL_MANAGER at A may configure A — not the tenant, not the platform, not another tenant's property
    await api()
      .put(`/config/values/${key}`)
      .set(bearer(gm.access))
      .send({
        scope: 'PROPERTY',
        propertyId: propA,
        value: '13:00',
        reason: 'late checkout policy',
      })
      .expect(200);
    await api()
      .put(`/config/values/${key}`)
      .set(bearer(gm.access))
      .send({ scope: 'TENANT', value: '10:00' })
      .expect(403);
    await api()
      .put(`/config/values/${key}`)
      .set(bearer(gm.access))
      .send({ scope: 'PLATFORM', value: '10:00' })
      .expect(403);
    await api()
      .put(`/config/values/${key}`)
      .set(bearer(gm.access))
      .send({ scope: 'PROPERTY', propertyId: foreignProp, value: '10:00' })
      .expect(404);
    const invalid = await api()
      .put(`/config/values/${key}`)
      .set(bearer(gm.access))
      .send({ scope: 'PROPERTY', propertyId: propA, value: '25:00' })
      .expect(422);
    expect(invalid.body.code).toBe('platform.config.invalid_value');
    const wrongScope = await api()
      .put('/config/values/iam.password.min_length')
      .set(bearer(gm.access))
      .send({ scope: 'PROPERTY', propertyId: propA, value: 14 })
      .expect(422);
    expect(wrongScope.body.code).toBe('platform.config.scope_not_allowed');
    // effective values
    const atA = await api()
      .get(`/config/effective/${key}?propertyId=${propA}`)
      .set(bearer(gm.access))
      .expect(200);
    expect(atA.body).toMatchObject({ value: '13:00', source: 'PROPERTY' });
    await api()
      .get(`/config/effective/${key}?propertyId=${propB}`)
      .set(bearer(gm.access))
      .expect(403);
    const atB = await api()
      .get(`/config/effective/${key}?tenantId=${tenantId}&propertyId=${propB}`)
      .set(bearer(adminToken))
      .expect(200);
    expect(atB.body).toMatchObject({ value: '11:00', source: 'PLATFORM' });
    // removing the override falls back; both changes are in the audit trail
    await api()
      .delete(`/config/values/${key}?scope=PROPERTY&propertyId=${propA}&reason=revert`)
      .set(bearer(gm.access))
      .expect(200);
    expect(
      (
        await api()
          .get(`/config/effective/${key}?propertyId=${propA}`)
          .set(bearer(gm.access))
          .expect(200)
      ).body,
    ).toMatchObject({ value: '11:00', source: 'PLATFORM' });
    const trail = await api()
      .get(`/audit?propertyId=${propA}&action=platform.configuration.`)
      .set(bearer(gm.access))
      .expect(200);
    expect(trail.body.data.map((e: { action: string }) => e.action)).toEqual([
      'platform.configuration.remove',
      'platform.configuration.set',
    ]);
    expect(trail.body.data[1]).toMatchObject({
      reason: 'late checkout policy',
      after: { value: '13:00' },
    });
  });

  it('a tenant can raise the password minimum and it applies to its staff', async () => {
    await api()
      .put('/config/values/iam.password.min_length')
      .set(bearer(adminToken))
      .send({ scope: 'TENANT', tenantId, value: 16 })
      .expect(200);
    await api()
      .put('/config/values/iam.password.min_length')
      .set(bearer(adminToken))
      .send({ scope: 'TENANT', tenantId, value: 8 })
      .expect(422); // never below the platform floor
    const invited = await api()
      .post(`/tenants/${tenantId}/users`)
      .set(bearer(adminToken))
      .send({ email: `pw-${stamp}@nile.example`, givenName: 'Pw' })
      .expect(201);
    const short = await api()
      .post('/auth/invitations/accept')
      .send({ token: invited.body.invitation.token, password: 'thirteen char' })
      .expect(422);
    expect(short.body).toMatchObject({ code: 'iam.password.too_short', params: { min: 16 } });
    await api()
      .post('/auth/invitations/accept')
      .send({ token: invited.body.invitation.token, password: 'sixteen chars ok!' })
      .expect(200);
  });

  it('retention policies: platform defaults plus tenant overrides, managed with config.manage', async () => {
    await api()
      .put('/retention-policies')
      .set(bearer(adminToken))
      .send({ scope: 'PLATFORM', dataClass: 'SENSITIVE', retainDays: 365, action: 'ANONYMIZE' })
      .expect(200);
    await api()
      .put('/retention-policies')
      .set(bearer(gm.access))
      .send({ scope: 'TENANT', dataClass: 'SENSITIVE', retainDays: 30, action: 'DELETE' })
      .expect(403); // property-level manager
    await api()
      .put('/retention-policies')
      .set(bearer(adminToken))
      .send({
        scope: 'TENANT',
        tenantId,
        dataClass: 'SENSITIVE',
        entityType: 'guest.profile',
        retainDays: 730,
        action: 'ANONYMIZE',
        legalHold: true,
      })
      .expect(200);
    const list = await api()
      .get(`/retention-policies?tenantId=${tenantId}`)
      .set(bearer(adminToken))
      .expect(200);
    expect(list.body).toHaveLength(2);
    expect(
      list.body.find((p: { tenantId: string | null }) => p.tenantId === tenantId),
    ).toMatchObject({
      entityType: 'guest.profile',
      legalHold: true,
    });
  });

  it('the Powered by Planova attribution can only be hidden by a policy citing an entitlement', async () => {
    const db = app.get<Database>(DATABASE);
    const shown = await api().get(`/public/branding?property=${propA}`).expect(200);
    expect(shown.body.attribution).toEqual({
      show: true,
      label: 'Powered by Planova',
      href: 'https://planova.com.eg',
    });
    await expect(
      db.execute(
        sql`insert into platform.attribution_policies (tenant_id, show_powered_by) values (${tenantId}, false)`,
      ),
    ).rejects.toThrow();
    await db.execute(
      sql`insert into platform.attribution_policies (tenant_id, show_powered_by, override_entitlement_ref) values (${tenantId}, false, 'lic-white-label-1')`,
    );
    const hidden = await api().get(`/public/branding?property=${propA}`).expect(200);
    expect(hidden.body.attribution).toMatchObject({ show: false, label: 'Powered by Planova' });
    // another tenant is unaffected
    const other = await api().get(`/public/branding?property=${foreignProp}`).expect(200);
    expect(other.body.attribution.show).toBe(true);
    await db.execute(sql`delete from platform.attribution_policies where tenant_id = ${tenantId}`);
  });

  it('support access is explicit, scoped, time-limited, read-only by default, approved, audited and revocable (Spec §64)', async () => {
    const supportEmail = `support-${stamp.toLowerCase()}@planova.example`;
    await app.get(IdentityBootstrapService).createPlatformStaff({
      kind: 'SUPPORT',
      email: supportEmail,
      password: 'support engineer passphrase',
      givenName: 'Sara',
    });
    const sup = (
      await api()
        .post('/auth/login')
        .send({ email: supportEmail, password: 'support engineer passphrase' })
        .expect(200)
    ).body.accessToken as string;
    // no standing access
    await api().get(`/properties/${propA}`).set(bearer(sup)).expect(403);
    // request: read-only grants may only carry READ permissions
    const tooMuch = await api()
      .post(`/tenants/${tenantId}/support-access`)
      .set(bearer(sup))
      .send({
        propertyId: propA,
        reason: 'Investigating a room sync issue',
        scopes: ['org.property.manage'],
      })
      .expect(422);
    expect(tooMuch.body.code).toBe('iam.support.scope_not_read_only');
    const requested = await api()
      .post(`/tenants/${tenantId}/support-access`)
      .set(bearer(sup))
      .send({
        propertyId: propA,
        reason: 'Investigating a room sync issue',
        scopes: ['org.property.read'],
        durationMinutes: 60,
      })
      .expect(201);
    expect(requested.body).toMatchObject({ status: 'PENDING', readOnly: true, approvedBy: null });
    const grantId = requested.body.id as string;
    await api().get(`/properties/${propA}`).set(bearer(sup)).expect(403); // pending grants give nothing
    // only the hotel approves: not the requester, not a platform administrator
    await api()
      .post(`/tenants/${tenantId}/support-access/${grantId}/approve`)
      .set(bearer(sup))
      .expect(403);
    await api()
      .post(`/tenants/${tenantId}/support-access/${grantId}/approve`)
      .set(bearer(adminToken))
      .expect(403);
    const pending = await api()
      .get(`/tenants/${tenantId}/support-access`)
      .set(bearer(gm.access))
      .expect(200);
    expect(pending.body.map((g: { id: string }) => g.id)).toContain(grantId);
    const approved = await api()
      .post(`/tenants/${tenantId}/support-access/${grantId}/approve`)
      .set(bearer(gm.access))
      .expect(200);
    expect(approved.body).toMatchObject({ status: 'ACTIVE', approvedBy: gm.userId });
    expect(
      new Date(approved.body.expiresAt).getTime() - new Date(approved.body.startsAt).getTime(),
    ).toBe(3_600_000);
    // within the grant: read property A only
    await api().get(`/properties/${propA}`).set(bearer(sup)).expect(200);
    await api().get(`/properties/${propB}`).set(bearer(sup)).expect(403);
    await api()
      .patch(`/properties/${propA}`)
      .set(bearer(sup))
      .send({ version: 3, name: 'x' })
      .expect(403);
    await api().get(`/properties/${foreignProp}`).set(bearer(sup)).expect(403);
    // every support request is audited with actor type SUPPORT
    const trail = await api()
      .get(`/audit?propertyId=${propA}&action=support.`)
      .set(bearer(gm.access))
      .expect(200);
    expect(trail.body.data[0]).toMatchObject({
      action: 'support.access.use',
      actorType: 'SUPPORT',
      entityId: 'GET /properties/:propertyId',
    });
    const lifecycle = await api()
      .get(`/audit?propertyId=${propA}&action=iam.support_access.`)
      .set(bearer(gm.access))
      .expect(200);
    expect(lifecycle.body.data.map((e: { action: string }) => e.action)).toEqual([
      'iam.support_access.approve',
      'iam.support_access.request',
    ]);
    // revocable at any time
    await api()
      .post(`/tenants/${tenantId}/support-access/${grantId}/revoke`)
      .set(bearer(gm.access))
      .send({ reason: 'issue resolved' })
      .expect(200);
    await api().get(`/properties/${propA}`).set(bearer(sup)).expect(403);
    const mine = await api().get('/support-access/mine').set(bearer(sup)).expect(200);
    expect(mine.body.find((g: { id: string }) => g.id === grantId)).toMatchObject({
      status: 'REVOKED',
    });
  });

  it('refresh tokens rotate; reusing a rotated token revokes the whole session', async () => {
    const s = await login(`gm-${stamp}@nile.example`, 'nile palace sunrise');
    const r1 = await api().post('/auth/refresh').send({ refreshToken: s.refresh }).expect(200);
    expect(r1.body.refreshToken).not.toBe(s.refresh);
    expect(r1.body.sessionId).toBe(s.sessionId);
    await api().get('/me').set(bearer(r1.body.accessToken)).expect(200);
    // replay of the first token → reuse detected → family revoked
    const reuse = await api().post('/auth/refresh').send({ refreshToken: s.refresh }).expect(401);
    expect(reuse.body.code).toBe('iam.auth.invalid_refresh_token');
    await api().post('/auth/refresh').send({ refreshToken: r1.body.refreshToken }).expect(401);
    await api().get('/me').set(bearer(r1.body.accessToken)).expect(401);
  });

  it('logout ends the session immediately', async () => {
    const s = await login(`gm-${stamp}@nile.example`, 'nile palace sunrise');
    await api().get('/me').set(bearer(s.access)).expect(200);
    await api().post('/auth/logout').set(bearer(s.access)).expect(204);
    await api().get('/me').set(bearer(s.access)).expect(401);
  });

  it('TOTP MFA: enrol, activate, then sign-in needs a fresh code; codes cannot be replayed', async () => {
    const s = await login(`gm-${stamp}@nile.example`, 'nile palace sunrise');
    const enrol = await api().post('/auth/mfa/enroll').set(bearer(s.access)).expect(200);
    expect(enrol.body.otpauthUri).toContain('otpauth://totp/');
    const secret = enrol.body.secret as string;
    await api()
      .post('/auth/mfa/activate')
      .set(bearer(s.access))
      .send({ code: '000000' })
      .expect(422);
    const now = Date.now();
    await api()
      .post('/auth/mfa/activate')
      .set(bearer(s.access))
      .send({ code: totp(secret, now) })
      .expect(200);
    const step1 = await api()
      .post('/auth/login')
      .send({ tenantCode, email: `gm-${stamp}@nile.example`, password: 'nile palace sunrise' })
      .expect(200);
    expect(step1.body).toEqual({ mfaRequired: true, challengeToken: expect.any(String) });
    // the code used for activation (same time step) is rejected; the next step's code is accepted
    await api()
      .post('/auth/mfa/verify')
      .send({ challengeToken: step1.body.challengeToken, code: totp(secret, now) })
      .expect(401);
    const ok = await api()
      .post('/auth/mfa/verify')
      .send({ challengeToken: step1.body.challengeToken, code: totp(secret, now + 30_000) })
      .expect(200);
    await api().get('/me').set(bearer(ok.body.accessToken)).expect(200);
    gm.access = ok.body.accessToken;
  });

  it('locks the account after repeated failures, even for the right password', async () => {
    const email = `lock-${stamp}@nile.example`;
    const invited = await api()
      .post(`/tenants/${tenantId}/users`)
      .set(bearer(adminToken))
      .send({ email, givenName: 'Lock' })
      .expect(201);
    await api()
      .post('/auth/invitations/accept')
      .send({ token: invited.body.invitation.token, password: 'correct horse battery' })
      .expect(200);
    for (let i = 0; i < 5; i++)
      await api()
        .post('/auth/login')
        .send({ tenantCode, email, password: `wrong password ${i}` })
        .expect(401);
    await api()
      .post('/auth/login')
      .send({ tenantCode, email, password: 'correct horse battery' })
      .expect(401);
  });

  it('disabling a user revokes their sessions at once', async () => {
    const s = await login(`ra-${stamp}@nile.example`, null).catch(() => null);
    expect(s).toBeNull(); // still invited, never set a password
    const v = await api()
      .post(`/tenants/${tenantId}/users`)
      .set(bearer(adminToken))
      .send({
        email: `fd-${stamp}@nile.example`,
        givenName: 'Fady',
        memberships: [{ propertyId: propA, roleCodes: ['FRONT_DESK'] }],
      })
      .expect(201);
    await api()
      .post('/auth/invitations/accept')
      .send({ token: v.body.invitation.token, password: 'front desk smiles daily' })
      .expect(200);
    const session = await login(`fd-${stamp}@nile.example`, 'front desk smiles daily');
    await api().get('/me').set(bearer(session.access)).expect(200);
    await api()
      .patch(`/tenants/${tenantId}/users/${v.body.user.id}/status`)
      .set(bearer(adminToken))
      .send({ status: 'DISABLED' })
      .expect(200);
    await api().get('/me').set(bearer(session.access)).expect(401);
    await api().post('/auth/refresh').send({ refreshToken: session.refresh }).expect(401);
  });

  it('login is rate limited per IP', async () => {
    store.enforce = true;
    try {
      let last = 0;
      for (let i = 0; i < 11; i++)
        last = (
          await api().post('/auth/login').send({ email: ADMIN.email, password: 'nope nope nope' })
        ).status;
      expect(last).toBe(429);
    } finally {
      store.enforce = false;
    }
  });

  it("row-level security: inside a tenant transaction other tenants' rows are invisible and unwritable", async () => {
    const c = new Client({ connectionString: appUrl });
    await c.connect();
    try {
      const count = async (tenant: string | null, table: string, id: string) => {
        await c.query('BEGIN');
        if (tenant) await c.query(`select set_config('app.tenant_id', $1, true)`, [tenant]);
        const r = await c.query(`select count(*)::int as n from ${table} where id = $1`, [id]);
        await c.query('ROLLBACK');
        return r.rows[0].n as number;
      };
      // the application role is subject to RLS (not a superuser, no BYPASSRLS)
      const role = await c.query(
        `select rolsuper, rolbypassrls from pg_roles where rolname = current_user`,
      );
      expect(role.rows[0]).toEqual({ rolsuper: false, rolbypassrls: false });
      expect(await count(tenantId, 'org.properties', foreignProp)).toBe(0);
      expect(await count(otherTenantId, 'org.properties', foreignProp)).toBe(1);
      expect(await count(null, 'org.properties', foreignProp)).toBe(1); // platform-level work is not restricted
      expect(await count(tenantId, 'org.tenants', otherTenantId)).toBe(0);
      expect(await count(tenantId, 'iam.users', gm.userId)).toBe(1);
      expect(await count(otherTenantId, 'iam.users', gm.userId)).toBe(0);
      // a write that targets another tenant fails the policy check
      await c.query('BEGIN');
      await c.query(`select set_config('app.tenant_id', $1, true)`, [tenantId]);
      await expect(
        c
          .query(`update org.properties set name = 'hijack' where id = $1`, [foreignProp])
          .then((r) => r.rowCount),
      ).resolves.toBe(0);
      await expect(
        c.query(
          `insert into org.organizations (id, tenant_id, code, name) values ($1, $2, 'HIJACK', 'x')`,
          ['01a10000-0000-7000-8000-00000000abcd', otherTenantId],
        ),
      ).rejects.toThrow(/row-level security/);
      await c.query('ROLLBACK');
    } finally {
      await c.end();
    }
  });

  async function login(email: string, password: string | null) {
    const res = await api()
      .post('/auth/login')
      .send({ tenantCode, email, password: password ?? 'x'.repeat(12) });
    if (res.status !== 200 || res.body.mfaRequired) throw new Error(`login failed: ${res.status}`);
    return {
      access: res.body.accessToken as string,
      refresh: res.body.refreshToken as string,
      sessionId: res.body.sessionId as string,
    };
  }
});
