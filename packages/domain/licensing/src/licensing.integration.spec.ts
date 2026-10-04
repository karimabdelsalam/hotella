import { sql } from 'drizzle-orm';
import type { EventEnvelope } from '@hotella/contracts-events';
import { newId } from '@hotella/platform-database';
import { infraSkipReason, needsInfra, readTestInfra } from '@hotella/platform-testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LicenseCatalogService } from './application/catalog.service';
import { CAPABILITIES, METRICS } from './domain/catalog';
import { ADMIN, type LicensingHarness, staff, startLicensingApp } from './testing/harness';

const stamp = Date.now().toString(36).toUpperCase();

describe.skipIf(needsInfra())(`Licensing catalog and plans (${infraSkipReason()})`, () => {
  const url = readTestInfra().databaseUrl!;
  let h: LicensingHarness;
  const cause = (e: unknown) => {
    const err = e as Error & { cause?: Error };
    return err.cause?.message ?? err.message;
  };
  const outbox = async (type: string) =>
    (
      (
        await h.db.execute(
          sql`select envelope from platform.outbox where event_type = ${type} order by id`,
        )
      ).rows as Array<{ envelope: EventEnvelope }>
    ).map((r) => r.envelope);

  beforeAll(async () => {
    h = await startLicensingApp(url, 'hotella_app_license');
  });
  afterAll(async () => {
    await h?.app.close();
  });

  it('synchronises the code-defined catalog and labels it in the reader’s language', async () => {
    const en = await h
      .http()
      .get('/control/license/catalog')
      .set('X-Test-Actor', ADMIN)
      .expect(200);
    expect(en.body.product).toBe('HOTELLA');
    const codes = (en.body.capabilities as Array<{ code: string }>).map((c) => c.code);
    for (const c of CAPABILITIES) expect(codes).toContain(c.code);
    expect((en.body.metrics as unknown[]).length).toBeGreaterThanOrEqual(METRICS.length);
    expect(en.body.capabilities.find((c: { code: string }) => c.code === 'HOUSEKEEPING').name).toBe(
      'Housekeeping',
    );
    const ar = await h
      .http()
      .get('/control/license/catalog')
      .set('X-Test-Actor', ADMIN)
      .set('Accept-Language', 'ar')
      .expect(200);
    expect(ar.body.capabilities.find((c: { code: string }) => c.code === 'CORE').name).toBe(
      'المنصة الأساسية',
    );
    // Re-running is a no-op; nothing is duplicated.
    const before = await h.db.execute(sql`select count(*)::int as n from license.capabilities`);
    await h.app.get(LicenseCatalogService).sync();
    const after = await h.db.execute(sql`select count(*)::int as n from license.capabilities`);
    expect(after.rows[0]).toEqual(before.rows[0]);
  });

  it('refuses hotel staff', async () => {
    await h
      .http()
      .get('/control/license/plans')
      .set('X-Test-Actor', staff(newId(), newId()))
      .expect(403);
  });

  it('drafts, validates, publishes and freezes a plan version, then retires it', async () => {
    const code = `PRO_${stamp}`;
    const created = await h
      .http()
      .post('/control/license/plans')
      .set('X-Test-Actor', ADMIN)
      .send({
        code,
        translations: [
          { locale: 'en', name: 'Professional' },
          { locale: 'ar', name: 'الاحترافية' },
        ],
      })
      .expect(201);
    const planId = created.body.id as string;
    const draft = created.body.versions[0];
    expect(draft).toMatchObject({ versionNo: 1, status: 'DRAFT', items: [], limits: [] });
    await h
      .http()
      .post('/control/license/plans')
      .set('X-Test-Actor', ADMIN)
      .send({ code, translations: [{ locale: 'en', name: 'Again' }] })
      .expect(409);

    const base = `/control/license/plans/${planId}/versions/${draft.id}`;
    // Unknown capability and a gauge limit with a period are refused while drafting.
    const bad = await h
      .http()
      .put(base)
      .set('X-Test-Actor', ADMIN)
      .send({ version: draft.version, items: ['CORE', 'TELEPORTATION'] })
      .expect(422);
    expect(bad.body.code).toBe('license.plan.unknown_capability');
    await h
      .http()
      .put(base)
      .set('X-Test-Actor', ADMIN)
      .send({
        version: draft.version,
        limits: [
          {
            metricCode: 'ACTIVE_STAFF',
            scope: 'TENANT',
            period: 'MONTH',
            limitValue: 5,
            enforcement: 'HARD',
          },
        ],
      })
      .expect(422);
    // A draft without CORE saves, but does not publish.
    const noCore = await h
      .http()
      .put(base)
      .set('X-Test-Actor', ADMIN)
      .send({ version: draft.version, items: ['HOUSEKEEPING'] })
      .expect(200);
    const refused = await h
      .http()
      .post(`${base}/publish`)
      .set('X-Test-Actor', ADMIN)
      .send({ version: noCore.body.version })
      .expect(422);
    expect(refused.body.code).toBe('license.plan.core_required');

    const ready = await h
      .http()
      .put(base)
      .set('X-Test-Actor', ADMIN)
      .send({
        version: noCore.body.version,
        notes: 'Launch package',
        items: ['CORE', 'GUEST_EXPERIENCE', 'HOUSEKEEPING', 'AI_GUEST', 'CONNECTOR_OPERA5'],
        limits: [
          {
            metricCode: 'ACTIVE_PROPERTIES',
            scope: 'TENANT',
            period: 'NONE',
            limitValue: 3,
            enforcement: 'HARD',
          },
          {
            metricCode: 'AI_INPUT_TOKENS',
            scope: 'PROPERTY',
            period: 'MONTH',
            limitValue: 2_000_000,
            enforcement: 'SOFT',
          },
        ],
      })
      .expect(200);
    // Stale optimistic version.
    await h
      .http()
      .post(`${base}/publish`)
      .set('X-Test-Actor', ADMIN)
      .send({ version: noCore.body.version })
      .expect(409);
    const published = await h
      .http()
      .post(`${base}/publish`)
      .set('X-Test-Actor', ADMIN)
      .send({ version: ready.body.version })
      .expect(200);
    expect(published.body).toMatchObject({ status: 'PUBLISHED', notes: 'Launch package' });
    expect(published.body.items).toEqual([
      'AI_GUEST',
      'CONNECTOR_OPERA5',
      'CORE',
      'GUEST_EXPERIENCE',
      'HOUSEKEEPING',
    ]);
    const event = (await outbox('license.plan_version.published')).find(
      (e) => (e.payload as { plan_version_id: string }).plan_version_id === draft.id,
    );
    expect(event?.tenant_id).toBeNull();
    expect((event?.payload as { capabilities: string[] }).capabilities).toContain('HOUSEKEEPING');

    // Frozen: the API refuses, and so does the database.
    await h
      .http()
      .put(base)
      .set('X-Test-Actor', ADMIN)
      .send({ version: published.body.version, items: ['CORE'] })
      .expect(409);
    await expect(
      h.db.execute(sql`update license.plan_versions set notes = 'x' where id = ${draft.id}`),
    ).rejects.toSatisfy((e: Error) => /immutable/.test(cause(e)));
    await expect(
      h.db.execute(sql`delete from license.plan_version_items where plan_version_id = ${draft.id}`),
    ).rejects.toSatisfy((e: Error) => /immutable/.test(cause(e)));
    await expect(
      h.db.execute(
        sql`insert into license.plan_version_items (id, plan_version_id, capability_code) values (${newId()}, ${draft.id}, 'ENGINEERING')`,
      ),
    ).rejects.toSatisfy((e: Error) => /immutable/.test(cause(e)));

    // The next draft starts from the published content.
    const next = await h
      .http()
      .post(`/control/license/plans/${planId}/versions`)
      .set('X-Test-Actor', ADMIN)
      .send({})
      .expect(201);
    expect(next.body).toMatchObject({ versionNo: 2, status: 'DRAFT' });
    expect(next.body.items).toEqual(published.body.items);
    expect(next.body.limits).toHaveLength(2);
    await h
      .http()
      .post(`/control/license/plans/${planId}/versions`)
      .set('X-Test-Actor', ADMIN)
      .send({})
      .expect(409);

    const retired = await h
      .http()
      .post(`${base}/retire`)
      .set('X-Test-Actor', ADMIN)
      .send({ version: published.body.version })
      .expect(200);
    expect(retired.body.status).toBe('RETIRED');
    expect(retired.body.items).toEqual(published.body.items);

    const plan = await h
      .http()
      .get(`/control/license/plans/${planId}`)
      .set('X-Test-Actor', ADMIN)
      .expect(200);
    expect(plan.body.versions.map((v: { status: string }) => v.status)).toEqual([
      'DRAFT',
      'RETIRED',
    ]);
    expect(plan.body.translations).toHaveLength(2);

    const audit = await h.db.execute(
      sql`select action from audit.audit_log where entity_id in (${planId}, ${draft.id}) order by occurred_at`,
    );
    expect((audit.rows as Array<{ action: string }>).map((r) => r.action)).toEqual(
      expect.arrayContaining([
        'license.plan.create',
        'license.plan_version.update',
        'license.plan_version.publish',
        'license.plan_version.retire',
      ]),
    );
  });

  it('answers 404 for unknown plans and versions', async () => {
    await h.http().get(`/control/license/plans/${newId()}`).set('X-Test-Actor', ADMIN).expect(404);
    await h.http().get('/control/license/plans/not-a-uuid').set('X-Test-Actor', ADMIN).expect(404);
  });
});
