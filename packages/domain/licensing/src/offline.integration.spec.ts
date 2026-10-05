import { generateKeyPairSync, sign } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { newId } from '@hotella/platform-database';
import { infraSkipReason, needsInfra, readTestInfra } from '@hotella/platform-testing';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { EntitlementEngine } from './application/entitlement-engine';
import { SiteBundleStore } from './application/site-bundle.store';
import { bundleRequestMessage, publicKeyFromBase64, verifyBundle } from './domain/bundle';
import { effectiveEntitlements } from './domain/entitlements';
import { TenantLicenseRepositories } from './infrastructure/tenant-repositories';
import {
  ADMIN,
  createTenant,
  type LicensingHarness,
  staff,
  startLicensingApp,
} from './testing/harness';

const stamp = Date.now().toString(36).toUpperCase();
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** ADR-0021: licensing never turns a fault or an outage into a stopped hotel. */
describe.skipIf(needsInfra())(`Offline-resilient entitlements (${infraSkipReason()})`, () => {
  const url = readTestInfra().databaseUrl!;
  const gmId = newId();
  const site = generateKeyPairSync('ed25519');
  const sitePublic = site.publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
  let central: LicensingHarness;
  let hotel: { tenantId: string; propertyId: string };
  let installationId: string;
  let bundleKey: string;
  const gm = () => staff(gmId, hotel.tenantId);
  const system = () =>
    JSON.stringify({
      type: 'SYSTEM',
      id: 'system-job',
      tenantId: hotel.tenantId,
      isPlatformAdmin: false,
    });
  const grants = {
    [gmId]: ['demo.board.read', 'org.property.read'],
    'system-job': ['demo.board.read'],
  };
  const signedRequest = (id: string, at = new Date().toISOString(), key = site.privateKey) => ({
    installationId: id,
    at,
    signature: sign(null, bundleRequestMessage(id, at), key).toString('base64url'),
  });

  beforeAll(async () => {
    central = await startLicensingApp(url, 'hotella_app_license_off', grants);
    hotel = await createTenant(central, `OFF${stamp}`);
    const plan = await central
      .http()
      .post('/control/license/plans')
      .set('X-Test-Actor', ADMIN)
      .send({ code: `OFF_${stamp}`, translations: [{ locale: 'en', name: 'Offline' }] })
      .expect(201);
    const v = plan.body.versions[0];
    const base = `/control/license/plans/${plan.body.id}/versions/${v.id}`;
    const saved = await central
      .http()
      .put(base)
      .set('X-Test-Actor', ADMIN)
      .send({ version: v.version, items: ['CORE', 'HOUSEKEEPING'], limits: [] })
      .expect(200);
    await central
      .http()
      .post(`${base}/publish`)
      .set('X-Test-Actor', ADMIN)
      .send({ version: saved.body.version })
      .expect(200);
    await central
      .http()
      .post(`/control/tenants/${hotel.tenantId}/subscriptions`)
      .set('X-Test-Actor', ADMIN)
      .send({ planVersionId: v.id })
      .expect(201);
    await central.app.listen(0, '127.0.0.1');
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });
  afterAll(async () => {
    await central?.app.close();
  });

  it('answers from the last facts read when licensing cannot be read, within the grace only', async () => {
    const engine = central.app.get(EntitlementEngine);
    expect(await engine.can(hotel.tenantId, hotel.propertyId, 'HOUSEKEEPING')).toBe(true);
    vi.spyOn(central.app.get(TenantLicenseRepositories), 'subscriptions').mockRejectedValue(
      new Error('database unavailable'),
    );
    engine.invalidate(hotel.tenantId);
    // A licensing fault is not an outage: the gate keeps answering for people.
    expect(await engine.can(hotel.tenantId, hotel.propertyId, 'HOUSEKEEPING')).toBe(true);
    await central
      .http()
      .get(`/demo/board?propertyId=${hotel.propertyId}`)
      .set('X-Test-Actor', gm())
      .expect(200);
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 73 * HOUR });
    engine.invalidate(hotel.tenantId);
    await expect(engine.can(hotel.tenantId, hotel.propertyId, 'HOUSEKEEPING')).rejects.toThrow(
      'database unavailable',
    );
  });

  it('registers an installation by its public key and issues it a signed bundle', async () => {
    const control = `/control/tenants/${hotel.tenantId}/installations`;
    await central
      .http()
      .post(control)
      .set('X-Test-Actor', ADMIN)
      .send({
        name: 'Bad',
        publicKey: Buffer.from('not a key at all, just forty characters!!').toString('base64'),
      })
      .expect(422);
    await central
      .http()
      .post(control)
      .set('X-Test-Actor', gm())
      .send({ name: 'Mine', publicKey: sitePublic })
      .expect(403);
    const created = await central
      .http()
      .post(control)
      .set('X-Test-Actor', ADMIN)
      .send({ name: 'Red Sea resort server', publicKey: sitePublic })
      .expect(201);
    installationId = created.body.id;
    expect(created.body).toMatchObject({ status: 'ACTIVE', lastIssuedAt: null });
    bundleKey = (
      await central.http().get('/control/license/bundle-key').set('X-Test-Actor', ADMIN).expect(200)
    ).body.publicKey;

    const issued = await central
      .http()
      .post('/license/bundle')
      .send(signedRequest(installationId))
      .expect(200);
    const bundle = verifyBundle(issued.body.bundle, publicKeyFromBase64(bundleKey), {
      installationId,
      now: new Date(),
    });
    expect(bundle.payload.tenant_id).toBe(hotel.tenantId);
    expect([...effectiveEntitlements(bundle.facts, hotel.propertyId, new Date()).codes]).toContain(
      'HOUSEKEEPING',
    );
    expect(bundle.graceUntil.getTime() - bundle.validUntil.getTime()).toBe(30 * DAY);
    const listed = await central.http().get(control).set('X-Test-Actor', ADMIN).expect(200);
    expect(listed.body[0].lastIssuedAt).not.toBeNull();
    const audit = await central.db.execute(
      sql`select actor_type from audit.audit_log where action = 'license.bundle.issue' and entity_id = ${installationId}`,
    );
    expect(audit.rows[0]).toMatchObject({ actor_type: 'INTEGRATION' });
  });

  it('refuses unsigned, replayed, foreign-key and revoked requests', async () => {
    const other = generateKeyPairSync('ed25519');
    const body = (
      await central
        .http()
        .post('/license/bundle')
        .send(signedRequest(installationId, undefined, other.privateKey))
        .expect(401)
    ).body;
    expect(body.code).toBe('license.bundle.request_invalid');
    await central
      .http()
      .post('/license/bundle')
      .send(signedRequest(installationId, new Date(Date.now() - 10 * 60_000).toISOString()))
      .expect(401);
    await central.http().post('/license/bundle').send(signedRequest(newId())).expect(401);
    const second = await central
      .http()
      .post(`/control/tenants/${hotel.tenantId}/installations`)
      .set('X-Test-Actor', ADMIN)
      .send({ name: 'Old server', publicKey: sitePublic })
      .expect(201);
    await central
      .http()
      .post(`/control/tenants/${hotel.tenantId}/installations/${second.body.id}/revoke`)
      .set('X-Test-Actor', ADMIN)
      .send({ reason: 'server replaced' })
      .expect(200);
    const revoked = await central
      .http()
      .post('/license/bundle')
      .send(signedRequest(second.body.id))
      .expect(403);
    expect(revoked.body.code).toBe('license.installation.revoked');
  });

  it('a site installation runs on its bundle, keeps running in grace and refuses people only past it', async () => {
    const siteApp = await startLicensingApp(url, 'hotella_app_license_site', grants, {
      LICENSING_MODE: 'site',
      LICENSING_BUNDLE_PUBLIC_KEY: bundleKey,
      LICENSING_CONTROL_PLANE_URL: await central.app.getUrl(),
      LICENSING_INSTALLATION_ID: installationId,
      LICENSING_INSTALLATION_KEY_REF: 'vault://kv/hotella/license#installation_key',
    });
    try {
      const store = siteApp.app.get(SiteBundleStore);
      store.use(site.privateKey);
      const board = (actor: string) =>
        siteApp.http().get(`/demo/board?propertyId=${hotel.propertyId}`).set('X-Test-Actor', actor);
      // Before its first bundle nothing is entitled for people.
      await siteApp.db.execute(
        sql`delete from license.site_bundles where installation_id = ${installationId}`,
      );
      expect((await board(gm()).expect(403)).body.code).toBe('license.not_entitled');
      expect(await store.renew()).toBe(true);
      siteApp.app.get(EntitlementEngine).invalidate();
      await board(gm()).expect(200);

      // The control plane unreachable: renewal fails, the bundle keeps answering.
      expect(await store.renew(() => Promise.reject(new Error('no route to host')))).toBe(false);
      vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 10 * DAY });
      siteApp.app.get(EntitlementEngine).invalidate();
      expect((await store.current())?.state).toBe('GRACE');
      await board(gm()).expect(200);

      // Past the grace: people are refused, system work continues.
      vi.setSystemTime(Date.now() + 30 * DAY);
      siteApp.app.get(EntitlementEngine).invalidate();
      const refused = await board(gm()).expect(403);
      expect(refused.body.code).toBe('license.offline_expired');
      await board(system()).expect(200);
    } finally {
      await siteApp.app.close();
    }
  });
});
