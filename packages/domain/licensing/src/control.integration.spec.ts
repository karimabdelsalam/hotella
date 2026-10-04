import { sql } from 'drizzle-orm';
import { newId } from '@hotella/platform-database';
import { infraSkipReason, needsInfra, readTestInfra } from '@hotella/platform-testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WhiteLabelSweep } from './application/white-label.sweep';
import {
  ADMIN,
  createTenant,
  type LicensingHarness,
  staff,
  startLicensingApp,
} from './testing/harness';

const stamp = Date.now().toString(36).toUpperCase();

describe.skipIf(needsInfra())(`Control plane (${infraSkipReason()})`, () => {
  const url = readTestInfra().databaseUrl!;
  let h: LicensingHarness;
  let hotel: { tenantId: string; propertyId: string };
  const attribution = () => `/control/tenants/${hotel.tenantId}/attribution`;

  beforeAll(async () => {
    h = await startLicensingApp(url, 'hotella_app_license_ctl');
    hotel = await createTenant(h, `CTL${stamp}`);
  });
  afterAll(async () => {
    await h?.app.close();
  });

  it('hides “Powered by Planova” only while the tenant holds WHITE_LABEL, and brings it back when it ends', async () => {
    const shown = await h.http().get(attribution()).set('X-Test-Actor', ADMIN).expect(200);
    expect(shown.body).toMatchObject({ show: true, whiteLabelEntitled: false });
    const refused = await h
      .http()
      .put(attribution())
      .set('X-Test-Actor', ADMIN)
      .send({ showPoweredBy: false, reason: 'Customer asked' })
      .expect(403);
    expect(refused.body).toMatchObject({
      code: 'license.not_entitled',
      params: { capability: 'WHITE_LABEL' },
    });

    const grant = await h
      .http()
      .post(`/control/tenants/${hotel.tenantId}/grants`)
      .set('X-Test-Actor', ADMIN)
      .send({ capabilityCode: 'WHITE_LABEL', reason: 'White-label add-on sold' })
      .expect(201);
    const hidden = await h
      .http()
      .put(attribution())
      .set('X-Test-Actor', ADMIN)
      .send({ showPoweredBy: false, reason: 'White-label add-on' })
      .expect(200);
    expect(hidden.body).toMatchObject({ show: false, whiteLabelEntitled: true });
    // A hotel's own staff cannot touch it.
    await h
      .http()
      .put(attribution())
      .set('X-Test-Actor', staff(newId(), hotel.tenantId))
      .send({ showPoweredBy: true, reason: 'Trying' })
      .expect(403);

    // While entitled, the daily sweep leaves it alone; once the grant is revoked it shows the line again.
    expect(await h.app.get(WhiteLabelSweep).run()).toBe(0);
    await h
      .http()
      .post(`/control/tenants/${hotel.tenantId}/grants/${grant.body.id}/revoke`)
      .set('X-Test-Actor', ADMIN)
      .send({ reason: 'Add-on cancelled' })
      .expect(200);
    expect(await h.app.get(WhiteLabelSweep).run()).toBe(1);
    const back = await h.http().get(attribution()).set('X-Test-Actor', ADMIN).expect(200);
    expect(back.body).toMatchObject({ show: true, whiteLabelEntitled: false });
    const audit = await h.db.execute(
      sql`select action, reason from audit.audit_log where entity_type = 'attribution_policy' and entity_id = ${hotel.tenantId} order by occurred_at`,
    );
    expect(audit.rows).toEqual([
      { action: 'platform.attribution_policy.set', reason: 'White-label add-on' },
      { action: 'platform.attribution_policy.restore', reason: 'white-label entitlement ended' },
    ]);
  });

  it('sets feature flags with a reason, audited (release control, not licensing)', async () => {
    const key = `ctl.test.${stamp.toLowerCase()}`;
    const set = await h
      .http()
      .put('/control/feature-flags')
      .set('X-Test-Actor', ADMIN)
      .send({
        key,
        scope: 'TENANT',
        scopeId: hotel.tenantId,
        enabled: true,
        reason: 'Canary for this hotel',
      })
      .expect(200);
    expect(set.body).toEqual([expect.objectContaining({ key, scope: 'TENANT', enabled: true })]);
    await h
      .http()
      .put('/control/feature-flags')
      .set('X-Test-Actor', ADMIN)
      .send({ key, scope: 'TENANT', enabled: true, reason: 'No scope id' })
      .expect(400);
    const all = await h.http().get('/control/feature-flags').set('X-Test-Actor', ADMIN).expect(200);
    expect((all.body as Array<{ key: string }>).some((f) => f.key === key)).toBe(true);
    const audit = await h.db.execute(
      sql`select reason from audit.audit_log where entity_type = 'feature_flag' and entity_id = ${key}`,
    );
    expect(audit.rows).toEqual([{ reason: 'Canary for this hotel' }]);
    await h
      .http()
      .get('/control/feature-flags')
      .set('X-Test-Actor', staff(newId(), hotel.tenantId))
      .expect(403);
  });

  it('lists every tenant’s subscriptions with their plan for the overview', async () => {
    const plan = await h
      .http()
      .post('/control/license/plans')
      .set('X-Test-Actor', ADMIN)
      .send({ code: `CTL_${stamp}`, translations: [{ locale: 'en', name: 'Control' }] })
      .expect(201);
    const v = plan.body.versions[0];
    const base = `/control/license/plans/${plan.body.id}/versions/${v.id}`;
    const saved = await h
      .http()
      .put(base)
      .set('X-Test-Actor', ADMIN)
      .send({ version: v.version, items: ['CORE'] })
      .expect(200);
    await h
      .http()
      .post(`${base}/publish`)
      .set('X-Test-Actor', ADMIN)
      .send({ version: saved.body.version })
      .expect(200);
    await h
      .http()
      .post(`/control/tenants/${hotel.tenantId}/subscriptions`)
      .set('X-Test-Actor', ADMIN)
      .send({ planVersionId: v.id })
      .expect(201);
    const overview = await h
      .http()
      .get('/control/subscriptions')
      .set('X-Test-Actor', ADMIN)
      .expect(200);
    expect(
      (overview.body as Array<{ tenantId: string }>).find((s) => s.tenantId === hotel.tenantId),
    ).toMatchObject({ status: 'ACTIVE', plan: { code: `CTL_${stamp}`, versionNo: 1 } });
  });
});
