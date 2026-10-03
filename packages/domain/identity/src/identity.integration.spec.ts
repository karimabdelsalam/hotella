import 'reflect-metadata';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ZodValidationPipe } from 'nestjs-zod';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OrganizationModule } from '@hotella/domain-organization';
import { AuthModule } from '@hotella/platform-auth';
import { ConfigModule } from '@hotella/platform-config';
import { DatabaseModule, runMigrations } from '@hotella/platform-database';
import { EventsModule } from '@hotella/platform-events';
import { FeatureFlagsModule } from '@hotella/platform-flags';
import { HttpConventionsModule, KV_STORE, MemoryKeyValueStore } from '@hotella/platform-http';
import { I18nModule } from '@hotella/platform-i18n';
import { ManifestModule } from '@hotella/platform-manifest';
import { ObservabilityModule } from '@hotella/platform-observability';
import { SecretsModule } from '@hotella/platform-secrets';
import { infraSkipReason, needsInfra, readTestInfra } from '@hotella/platform-testing';
import { IdentityBootstrapService } from './application/bootstrap.service';
import { IdentityCatalogService } from './application/catalog.service';
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
    const ref = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          env: {
            NODE_ENV: 'test',
            LOG_LEVEL: 'silent',
            DATABASE_URL: url,
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
