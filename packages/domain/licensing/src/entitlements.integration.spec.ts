import { sql } from 'drizzle-orm';
import type { EventEnvelope } from '@hotella/contracts-events';
import { newId } from '@hotella/platform-database';
import { infraSkipReason, needsInfra, readTestInfra } from '@hotella/platform-testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EntitlementEngine } from './application/entitlement-engine';
import {
  ADMIN,
  createTenant,
  type LicensingHarness,
  staff,
  startLicensingApp,
} from './testing/harness';

const stamp = Date.now().toString(36).toUpperCase();

describe.skipIf(needsInfra())(
  `Subscriptions, grants and the entitlement stage (${infraSkipReason()})`,
  () => {
    const url = readTestInfra().databaseUrl!;
    const gmId = newId();
    const otherGmId = newId();
    let h: LicensingHarness;
    let hotel: { tenantId: string; propertyId: string };
    let p2: string;
    let other: { tenantId: string; propertyId: string };
    let coreVersion: string;
    let limitedVersion: string;
    let draftVersion: string;
    const gm = () => staff(gmId, hotel.tenantId);
    const control = () => `/control/tenants/${hotel.tenantId}`;
    const system = () =>
      JSON.stringify({
        type: 'SYSTEM',
        id: 'system-job',
        tenantId: hotel.tenantId,
        isPlatformAdmin: false,
      });

    async function publishedPlan(
      code: string,
      items: string[],
      limits: unknown[] = [],
    ): Promise<string> {
      const plan = await h
        .http()
        .post('/control/license/plans')
        .set('X-Test-Actor', ADMIN)
        .send({ code, translations: [{ locale: 'en', name: code }] })
        .expect(201);
      const v = plan.body.versions[0];
      const base = `/control/license/plans/${plan.body.id}/versions/${v.id}`;
      const saved = await h
        .http()
        .put(base)
        .set('X-Test-Actor', ADMIN)
        .send({ version: v.version, items, limits })
        .expect(200);
      await h
        .http()
        .post(`${base}/publish`)
        .set('X-Test-Actor', ADMIN)
        .send({ version: saved.body.version })
        .expect(200);
      return v.id as string;
    }

    const demo = (path: 'board' | 'core', propertyId: string | null, actor = gm()) =>
      h
        .http()
        .get(`/demo/${path}${propertyId ? `?propertyId=${propertyId}` : ''}`)
        .set('X-Test-Actor', actor);

    beforeAll(async () => {
      h = await startLicensingApp(url, 'hotella_app_license_ent', {
        [gmId]: ['demo.board.read', 'org.property.read', 'license.tenant.read'],
        [otherGmId]: ['license.tenant.read'],
        'system-job': ['org.property.read'],
      });
      hotel = await createTenant(h, `ENT${stamp}`);
      other = await createTenant(h, `OTH${stamp}`);
      p2 = newId();
      await h.db.execute(
        sql`insert into org.properties (id, tenant_id, code, name, timezone, currency) values (${p2}, ${hotel.tenantId}, 'P2', 'Second', 'Africa/Cairo', 'EGP')`,
      );
      coreVersion = await publishedPlan(`CORE_${stamp}`, ['CORE']);
      limitedVersion = await publishedPlan(
        `LIM_${stamp}`,
        ['CORE', 'GUEST_EXPERIENCE'],
        [
          {
            metricCode: 'ACTIVE_PROPERTIES',
            scope: 'TENANT',
            period: 'NONE',
            limitValue: 2,
            enforcement: 'HARD',
          },
        ],
      );
      const draft = await h
        .http()
        .post('/control/license/plans')
        .set('X-Test-Actor', ADMIN)
        .send({ code: `DRAFT_${stamp}`, translations: [{ locale: 'en', name: 'Draft' }] })
        .expect(201);
      draftVersion = draft.body.versions[0].id;
    });
    afterAll(async () => {
      await h?.app.close();
    });

    it('refuses people of an unlicensed tenant, but never system work', async () => {
      const core = await demo('core', null).expect(403);
      expect(core.body.code).toBe('license.not_entitled');
      expect(core.body.detail).toBe("Your hotel's licence does not include this feature.");
      expect(core.body.params).toEqual({ capability: 'CORE' });
      expect((await demo('board', hotel.propertyId).expect(403)).body.code).toBe(
        'license.not_entitled',
      );
      await demo('core', null, system()).expect(200);
      // A tenant can always read its own licence, even without one.
      const own = await h
        .http()
        .get(`/tenants/${hotel.tenantId}/license`)
        .set('X-Test-Actor', gm())
        .expect(200);
      expect(own.body).toMatchObject({ subscriptions: [], entitlements: [] });
    });

    it('subscribes a tenant to a published plan version only', async () => {
      await h
        .http()
        .post(`${control()}/subscriptions`)
        .set('X-Test-Actor', ADMIN)
        .send({ planVersionId: draftVersion })
        .expect(409);
      await h
        .http()
        .post(`/control/tenants/${newId()}/subscriptions`)
        .set('X-Test-Actor', ADMIN)
        .send({ planVersionId: coreVersion })
        .expect(404);
      await h
        .http()
        .post(`${control()}/subscriptions`)
        .set('X-Test-Actor', ADMIN)
        .send({ planVersionId: coreVersion, scope: 'PROPERTIES', propertyIds: [other.propertyId] })
        .expect(404);
      await h
        .http()
        .post(`${control()}/subscriptions`)
        .set('X-Test-Actor', staff(gmId, hotel.tenantId))
        .send({ planVersionId: coreVersion })
        .expect(403);
      const sub = await h
        .http()
        .post(`${control()}/subscriptions`)
        .set('X-Test-Actor', ADMIN)
        .send({ planVersionId: coreVersion, reason: 'Pilot contract' })
        .expect(201);
      expect(sub.body).toMatchObject({ status: 'ACTIVE', scope: 'TENANT', plan: { versionNo: 1 } });
      expect(sub.body.history.map((x: { change: string }) => x.change)).toEqual(['CREATED']);
      await demo('core', hotel.propertyId).expect(200);
      // CORE does not include housekeeping.
      expect(
        (await demo('board', hotel.propertyId).expect(403)).body.params?.capability ??
          'HOUSEKEEPING',
      ).toBe('HOUSEKEEPING');
      const mine = await h
        .http()
        .get(`/me/entitlements?propertyId=${hotel.propertyId}`)
        .set('X-Test-Actor', gm())
        .expect(200);
      expect(mine.body).toEqual({
        propertyId: hotel.propertyId,
        unrestricted: false,
        codes: ['CORE'],
      });
    });

    it('applies a property grant to that property only and revokes it', async () => {
      const grant = await h
        .http()
        .post(`${control()}/grants`)
        .set('X-Test-Actor', ADMIN)
        .send({
          capabilityCode: 'HOUSEKEEPING',
          propertyId: p2,
          source: 'TRIAL',
          reason: 'Trial at the second hotel',
        })
        .expect(201);
      await demo('board', p2).expect(200);
      await demo('board', hotel.propertyId).expect(403);
      await h
        .http()
        .post(`${control()}/grants`)
        .set('X-Test-Actor', ADMIN)
        .send({ capabilityCode: 'TELEPORTATION', reason: 'nope nope' })
        .expect(422);
      const view = await h
        .http()
        .get(`${control()}/entitlements?propertyId=${p2}`)
        .set('X-Test-Actor', ADMIN)
        .expect(200);
      expect(
        view.body.entitlements.find((e: { code: string }) => e.code === 'HOUSEKEEPING').sources,
      ).toEqual([{ kind: 'GRANT', id: grant.body.id, until: null }]);
      await h
        .http()
        .post(`${control()}/grants/${grant.body.id}/revoke`)
        .set('X-Test-Actor', ADMIN)
        .send({ reason: 'Trial over' })
        .expect(200);
      await demo('board', p2).expect(403);
      await h
        .http()
        .post(`${control()}/grants/${grant.body.id}/revoke`)
        .set('X-Test-Actor', ADMIN)
        .send({ reason: 'Again' })
        .expect(409);
      // The other tenant never sees this tenant's grants.
      const theirs = await h
        .http()
        .get(`/control/tenants/${other.tenantId}/grants`)
        .set('X-Test-Actor', ADMIN)
        .expect(200);
      expect(theirs.body).toEqual([]);
      await expect(
        h.db.execute(sql`delete from license.entitlement_grants where id = ${grant.body.id}`),
      ).rejects.toThrow();
    });

    it('follows the subscription through suspension and back, keeping its history', async () => {
      const [sub] = (
        await h.http().get(`${control()}/subscriptions`).set('X-Test-Actor', ADMIN).expect(200)
      ).body;
      const suspended = await h
        .http()
        .post(`${control()}/subscriptions/${sub.id}/transition`)
        .set('X-Test-Actor', ADMIN)
        .send({ version: sub.version, status: 'SUSPENDED', reason: 'Unpaid for 60 days' })
        .expect(200);
      await demo('core', null).expect(403);
      await demo('core', null, system()).expect(200);
      // The tenant still reads its licence while suspended.
      const own = await h
        .http()
        .get(`/tenants/${hotel.tenantId}/license`)
        .set('X-Test-Actor', gm())
        .expect(200);
      expect(own.body.subscriptions[0].status).toBe('SUSPENDED');
      const active = await h
        .http()
        .post(`${control()}/subscriptions/${sub.id}/transition`)
        .set('X-Test-Actor', ADMIN)
        .send({ version: suspended.body.version, status: 'ACTIVE', reason: 'Paid' })
        .expect(200);
      await demo('core', null).expect(200);
      // Upgrade to the plan with guest experience and a property limit.
      const upgraded = await h
        .http()
        .post(`${control()}/subscriptions/${sub.id}/change`)
        .set('X-Test-Actor', ADMIN)
        .send({ version: active.body.version, planVersionId: limitedVersion, reason: 'Upgrade' })
        .expect(200);
      expect(
        upgraded.body.history.map(
          (x: { change: string; toStatus: string }) => `${x.change}:${x.toStatus}`,
        ),
      ).toEqual(['CREATED:ACTIVE', 'STATUS:SUSPENDED', 'STATUS:ACTIVE', 'PLAN:ACTIVE']);
      const cancelled = await h
        .http()
        .post(`${control()}/subscriptions/${sub.id}/transition`)
        .set('X-Test-Actor', ADMIN)
        .send({ version: upgraded.body.version, status: 'CANCELLED', reason: 'Test end' })
        .expect(200);
      const back = await h
        .http()
        .post(`${control()}/subscriptions/${sub.id}/transition`)
        .set('X-Test-Actor', ADMIN)
        .send({ version: cancelled.body.version, status: 'ACTIVE', reason: 'Undo' })
        .expect(409);
      expect(back.body.code).toBe('license.subscription.transition_invalid');
      const events = (
        await h.db.execute(
          sql`select event_type, envelope from platform.outbox where tenant_id = ${hotel.tenantId} and event_type like 'license.%' order by id`,
        )
      ).rows as Array<{ event_type: string; envelope: EventEnvelope }>;
      expect(
        events
          .filter((e) => e.event_type === 'license.subscription.changed')
          .map((e) => (e.envelope.payload as { to_status: string }).to_status),
      ).toEqual(['ACTIVE', 'SUSPENDED', 'ACTIVE', 'ACTIVE', 'CANCELLED']);
      expect(events.some((e) => e.event_type === 'license.entitlements.changed')).toBe(true);
      await expect(
        h.db.execute(
          sql`update license.subscription_history set reason = 'x' where tenant_id = ${hotel.tenantId}`,
        ),
      ).rejects.toThrow();
    });

    it('enforces HARD limits through the engine, with overrides', async () => {
      const sub = await h
        .http()
        .post(`${control()}/subscriptions`)
        .set('X-Test-Actor', ADMIN)
        .send({ planVersionId: limitedVersion })
        .expect(201);
      expect(sub.body.status).toBe('ACTIVE');
      const engine = h.app.get(EntitlementEngine);
      const check = (current: number) =>
        engine.assertWithinLimit({
          tenantId: hotel.tenantId,
          propertyId: null,
          metric: 'ACTIVE_PROPERTIES',
          current,
        });
      await expect(check(1)).resolves.toBeUndefined();
      await expect(check(2)).rejects.toMatchObject({ code: 'license.limit_reached' });
      const override = await h
        .http()
        .post(`${control()}/limit-overrides`)
        .set('X-Test-Actor', ADMIN)
        .send({
          metricCode: 'ACTIVE_PROPERTIES',
          period: 'NONE',
          limitValue: 5,
          enforcement: 'HARD',
          reason: 'Group deal',
        })
        .expect(201);
      await expect(check(4)).resolves.toBeUndefined();
      await h
        .http()
        .post(`${control()}/limit-overrides`)
        .set('X-Test-Actor', ADMIN)
        .send({
          metricCode: 'ACTIVE_PROPERTIES',
          period: 'MONTH',
          limitValue: 5,
          enforcement: 'HARD',
          reason: 'Wrong period',
        })
        .expect(422);
      await h
        .http()
        .post(`${control()}/limit-overrides/${override.body.id}/revoke`)
        .set('X-Test-Actor', ADMIN)
        .send({ reason: 'Deal ended' })
        .expect(200);
      await expect(check(4)).rejects.toMatchObject({ code: 'license.limit_reached' });
      const own = await h
        .http()
        .get(`/tenants/${hotel.tenantId}/license`)
        .set('X-Test-Actor', gm())
        .expect(200);
      expect(own.body.limits).toEqual([
        expect.objectContaining({
          metricCode: 'ACTIVE_PROPERTIES',
          limitValue: 2,
          enforcement: 'HARD',
        }),
      ]);
      expect(own.body.entitlements.map((e: { code: string }) => e.code)).toEqual([
        'CORE',
        'GUEST_EXPERIENCE',
      ]);
    });

    it('never confirms another tenant', async () => {
      await h
        .http()
        .get(`/tenants/${hotel.tenantId}/license`)
        .set('X-Test-Actor', staff(otherGmId, other.tenantId))
        .expect(404);
      await h
        .http()
        .get(`/me/entitlements?propertyId=${hotel.propertyId}`)
        .set('X-Test-Actor', staff(otherGmId, other.tenantId))
        .expect(404);
    });
  },
);
