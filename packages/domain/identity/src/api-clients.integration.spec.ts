import 'reflect-metadata';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { sql } from 'drizzle-orm';
import { ZodValidationPipe } from 'nestjs-zod';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  LicenseCatalogService,
  LicensingCoreModule,
  LicensingModule,
} from '@hotella/domain-licensing';
import { OrganizationModule } from '@hotella/domain-organization';
import { AuditModule } from '@hotella/platform-audit';
import { AuthModule } from '@hotella/platform-auth';
import { ConfigModule } from '@hotella/platform-config';
import {
  applicationRoleUrl,
  DATABASE,
  type Database,
  DatabaseModule,
  runMigrations,
} from '@hotella/platform-database';
import { EventsModule } from '@hotella/platform-events';
import { FeatureFlagsModule } from '@hotella/platform-flags';
import { HttpConventionsModule } from '@hotella/platform-http';
import { I18nModule } from '@hotella/platform-i18n';
import { ManifestModule } from '@hotella/platform-manifest';
import { ObservabilityModule } from '@hotella/platform-observability';
import { SecretsModule } from '@hotella/platform-secrets';
import { SettingsModule } from '@hotella/platform-settings';
import { infraSkipReason, needsInfra, readTestInfra } from '@hotella/platform-testing';
import { IdentityBootstrapService } from './application/bootstrap.service';
import { IdentityCatalogService } from './application/catalog.service';
import { IdentityCoreModule } from './identity-core.module';
import { IdentityModule, identityAuthOptions, identityLocalePreferences } from './identity.module';

const stamp = Date.now().toString(36).toUpperCase();
const ADMIN = {
  email: `keys-${stamp.toLowerCase()}@planova.example`,
  password: 'platform admin passphrase 2',
};

describe.skipIf(needsInfra())(
  `API clients of the developer platform against PostgreSQL (${infraSkipReason()})`,
  () => {
    const url = readTestInfra().databaseUrl!;
    let app: INestApplication;
    let db: Database;
    const api = () => request(app.getHttpServer());
    const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });
    let admin: string;
    let gm: string;
    let tenantId: string;
    let propertyId: string;
    let foreignProperty: string;
    let key: string;
    let clientId: string;
    let apiAccessGrant: string;

    const login = async (body: Record<string, string>) =>
      (await api().post('/auth/login').send(body).expect(200)).body.accessToken as string;
    const grant = async (capabilityCode: string) =>
      (
        await api()
          .post(`/control/tenants/${tenantId}/grants`)
          .set(bearer(admin))
          .send({ capabilityCode, reason: 'developer platform test' })
          .expect(201)
      ).body.id as string;

    beforeAll(async () => {
      await runMigrations(url);
      const ref = await Test.createTestingModule({
        imports: [
          ConfigModule.forRoot({
            env: {
              NODE_ENV: 'test',
              LOG_LEVEL: 'silent',
              DATABASE_URL: await applicationRoleUrl(url, 'hotella_app_identity_keys'),
              VALKEY_URL: 'redis://127.0.0.1:1',
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
            stages: [LicensingCoreModule.entitlementStage()],
          }),
          OrganizationModule,
          IdentityModule,
          LicensingModule,
        ],
      }).compile();
      app = ref.createNestApplication({ logger: false });
      app.useGlobalPipes(new ZodValidationPipe());
      await app.init();
      db = app.get(DATABASE);
      await app.get(LicenseCatalogService).sync();
      await app.get(IdentityCatalogService).sync();
      await app.get(IdentityBootstrapService).createPlatformAdmin({ ...ADMIN, givenName: 'Root' });
      admin = await login(ADMIN);

      const tenant = async (code: string) =>
        (await api().post('/tenants').set(bearer(admin)).send({ code, name: code }).expect(201))
          .body.id as string;
      const property = async (t: string, code: string) =>
        (
          await api()
            .post('/properties')
            .set(bearer(admin))
            .send({ tenantId: t, code, name: code, timezone: 'Africa/Cairo', currency: 'EGP' })
            .expect(201)
        ).body.id as string;
      const tenantCode = `KEYS_${stamp}`;
      tenantId = await tenant(tenantCode);
      propertyId = await property(tenantId, 'CAI');
      foreignProperty = await property(await tenant(`OTHER_${stamp}`), 'HRG');
      const invited = await api()
        .post(`/tenants/${tenantId}/users`)
        .set(bearer(admin))
        .send({
          email: `gm-${stamp.toLowerCase()}@keys.example`,
          givenName: 'Gm',
          // Tenant-wide: API clients and webhooks are managed for the whole tenant.
          memberships: [{ roleCodes: ['GENERAL_MANAGER'] }],
        })
        .expect(201);
      await api()
        .post('/auth/invitations/accept')
        .send({ token: invited.body.invitation.token, password: 'keys and hooks 2026' })
        .expect(200);
      gm = await login({
        tenantCode,
        email: `gm-${stamp.toLowerCase()}@keys.example`,
        password: 'keys and hooks 2026',
      });
      await grant('CORE');
    });
    afterAll(() => app?.close());

    it('API clients need the API_ACCESS entitlement', async () => {
      const res = await api()
        .post(`/tenants/${tenantId}/api-clients`)
        .set(bearer(gm))
        .send({ name: 'PMS bridge', propertyId, scopes: ['org.property.read'] })
        .expect(403);
      expect(res.body).toMatchObject({
        code: 'license.not_entitled',
        params: { capability: 'API_ACCESS' },
      });
      apiAccessGrant = await grant('API_ACCESS');
    });

    it('scopes never exceed the creator and never include people, support or licence administration', async () => {
      const forbidden = await api()
        .post(`/tenants/${tenantId}/api-clients`)
        .set(bearer(gm))
        .send({ name: 'x', propertyId, scopes: ['org.property.read', 'iam.user.manage'] })
        .expect(403);
      expect(forbidden.body.code).toBe('iam.api_client.scope_not_allowed');
      const escalation = await api()
        .post(`/tenants/${tenantId}/api-clients`)
        .set(bearer(gm))
        .send({ name: 'x', propertyId, scopes: ['org.tenant.manage'] })
        .expect(403);
      expect(escalation.body.code).toBe('iam.role.cannot_delegate');
    });

    it('creates a key shown once and authenticates with it inside its scopes and property only', async () => {
      const created = await api()
        .post(`/tenants/${tenantId}/api-clients`)
        .set(bearer(gm))
        .send({
          name: 'PMS bridge',
          propertyId,
          scopes: ['org.property.read', 'org.location.manage'],
        })
        .expect(201);
      key = created.body.key;
      clientId = created.body.client.id;
      expect(key).toMatch(/^hk_[A-Za-z0-9]{12}_[A-Za-z0-9_-]{43}$/);
      expect(created.body.client.keyPrefix).toBe(key.slice(3, 15));
      const list = await api().get(`/tenants/${tenantId}/api-clients`).set(bearer(gm)).expect(200);
      expect(JSON.stringify(list.body)).not.toContain(key.slice(16));
      const stored = await db.execute(
        sql`select secret_hash from iam.api_clients where id = ${clientId}`,
      );
      expect(JSON.stringify(stored.rows)).not.toContain(key.slice(16));

      const tree = await api()
        .get(`/properties/${propertyId}/locations`)
        .set(bearer(key))
        .expect(200);
      const root = Array.isArray(tree.body) ? tree.body[0].id : tree.body.id;
      await api()
        .post(`/properties/${propertyId}/rooms`)
        .set(bearer(key))
        .send({ parentId: root, roomNumber: '701' })
        .expect(201);
      // Outside its property, its tenant or its scopes.
      await api()
        .get(`/properties/${foreignProperty}/locations`)
        .set(bearer(key))
        .expect((r) => expect([403, 404]).toContain(r.status));
      await api().get(`/tenants/${tenantId}/users`).set(bearer(key)).expect(403);
      // A wrong secret is just unauthenticated.
      await api()
        .get(`/properties/${propertyId}/locations`)
        .set(bearer(`${key.slice(0, 16)}${'A'.repeat(43)}`))
        .expect(401);
    });

    it('meters every authenticated call as API_CALLS and audits the client as an integration actor', async () => {
      const usage = await db.execute(
        sql`select count(*)::int as n from license.usage_events where tenant_id = ${tenantId} and metric_code = 'API_CALLS'`,
      );
      expect((usage.rows[0] as { n: number }).n).toBeGreaterThanOrEqual(2);
      const audit = await db.execute(
        sql`select actor_type, actor_id from audit.audit_log where tenant_id = ${tenantId} and action like 'org.%' and actor_id = ${clientId}`,
      );
      expect(audit.rows.length).toBeGreaterThanOrEqual(1);
      expect((audit.rows[0] as { actor_type: string }).actor_type).toBe('INTEGRATION');
    });

    it('a lapsed API_ACCESS stops the key at once; revoking the client ends it for good', async () => {
      await api()
        .post(`/control/tenants/${tenantId}/grants/${apiAccessGrant}/revoke`)
        .set(bearer(admin))
        .send({ reason: 'add-on ended' })
        .expect(200);
      const refused = await api()
        .get(`/properties/${propertyId}/locations`)
        .set(bearer(key))
        .expect(403);
      expect(refused.body.code).toBe('license.not_entitled');
      await grant('API_ACCESS');
      await api().get(`/properties/${propertyId}/locations`).set(bearer(key)).expect(200);

      const revoked = await api()
        .post(`/tenants/${tenantId}/api-clients/${clientId}/revoke`)
        .set(bearer(gm))
        .send({ reason: 'key leaked in a log' })
        .expect(200);
      expect(revoked.body.status).toBe('REVOKED');
      await api().get(`/properties/${propertyId}/locations`).set(bearer(key)).expect(401);
      await api()
        .post(`/tenants/${tenantId}/api-clients/${clientId}/revoke`)
        .set(bearer(gm))
        .send({ reason: 'again' })
        .expect(404);
      await expect(
        db.execute(sql`delete from iam.api_clients where id = ${clientId}`),
      ).rejects.toThrow();
    });
  },
);
