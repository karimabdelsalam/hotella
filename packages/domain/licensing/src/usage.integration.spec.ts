import { sql } from 'drizzle-orm';
import type { EventEnvelope } from '@hotella/contracts-events';
import { newId, TransactionRunner } from '@hotella/platform-database';
import { infraSkipReason, needsInfra, readTestInfra } from '@hotella/platform-testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { UsageService } from './application/usage.service';
import { periodStart } from './domain/usage';
import {
  ADMIN,
  createTenant,
  type LicensingHarness,
  staff,
  startLicensingApp,
} from './testing/harness';

const stamp = Date.now().toString(36).toUpperCase();

describe.skipIf(needsInfra())(`Usage metering (${infraSkipReason()})`, () => {
  const url = readTestInfra().databaseUrl!;
  const gmId = newId();
  let h: LicensingHarness;
  let usage: UsageService;
  let hotel: { tenantId: string; propertyId: string };
  const month = periodStart('MONTH', new Date()).toISOString();
  const nextMonth = periodStart('MONTH', new Date(Date.now() + 32 * 86_400_000))
    .toISOString()
    .slice(0, 10);
  const aggregates = async (propertyKey: string, metric: string) =>
    (
      await h.db.execute(
        sql`select granularity, quantity::int as q from license.usage_aggregates where tenant_id = ${hotel.tenantId} and property_key = ${propertyKey} and metric_code = ${metric} order by granularity`,
      )
    ).rows as Array<{ granularity: string; q: number }>;
  const limitEvents = async () =>
    (
      (
        await h.db.execute(
          sql`select envelope from platform.outbox where tenant_id = ${hotel.tenantId} and event_type = 'license.limit.reached' order by id`,
        )
      ).rows as Array<{ envelope: EventEnvelope }>
    ).map((r) => r.envelope);
  const tokens = (quantity: number, key: string, propertyId: string | null = hotel.propertyId) =>
    usage.record({
      tenantId: hotel.tenantId,
      propertyId,
      metric: 'AI_INPUT_TOKENS',
      quantity,
      source: 'ai',
      idempotencyKey: key,
    });

  beforeAll(async () => {
    h = await startLicensingApp(url, 'hotella_app_license_use', {
      [gmId]: ['license.tenant.read'],
    });
    usage = h.app.get(UsageService);
    hotel = await createTenant(h, `USE${stamp}`);
    // A plan with a SOFT monthly token limit for the tenant and a HARD daily one per property.
    const plan = await h
      .http()
      .post('/control/license/plans')
      .set('X-Test-Actor', ADMIN)
      .send({ code: `USE_${stamp}`, translations: [{ locale: 'en', name: 'Usage' }] })
      .expect(201);
    const v = plan.body.versions[0];
    const base = `/control/license/plans/${plan.body.id}/versions/${v.id}`;
    const saved = await h
      .http()
      .put(base)
      .set('X-Test-Actor', ADMIN)
      .send({
        version: v.version,
        items: ['CORE', 'AI_GUEST'],
        limits: [
          {
            metricCode: 'AI_INPUT_TOKENS',
            scope: 'TENANT',
            period: 'MONTH',
            limitValue: 1000,
            enforcement: 'SOFT',
          },
          {
            metricCode: 'AI_INPUT_TOKENS',
            scope: 'PROPERTY',
            period: 'DAY',
            limitValue: 5000,
            enforcement: 'HARD',
          },
          {
            metricCode: 'ACTIVE_STAFF',
            scope: 'TENANT',
            period: 'NONE',
            limitValue: 3,
            enforcement: 'SOFT',
          },
        ],
      })
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
  });
  afterAll(async () => {
    await h?.app.close();
  });

  it('records idempotently and aggregates per tenant and property, by day and month', async () => {
    expect(await tokens(400, 'call-1')).toBe(true);
    expect(await tokens(400, 'call-1')).toBe(false);
    expect(await tokens(200, 'call-2')).toBe(true);
    expect(await aggregates(hotel.propertyId, 'AI_INPUT_TOKENS')).toEqual([
      { granularity: 'DAY', q: 600 },
      { granularity: 'MONTH', q: 600 },
    ]);
    expect(await aggregates(hotel.tenantId, 'AI_INPUT_TOKENS')).toEqual([
      { granularity: 'DAY', q: 600 },
      { granularity: 'MONTH', q: 600 },
    ]);
    await expect(
      usage.record({
        tenantId: hotel.tenantId,
        propertyId: null,
        metric: 'TELEPATHY',
        quantity: 1,
        source: 'x',
        idempotencyKey: 'x',
      }),
    ).rejects.toMatchObject({ code: 'license.metric.unknown' });
  });

  it('commits with the caller’s transaction, and not without it', async () => {
    const tx = h.app.get(TransactionRunner);
    await expect(
      tx.run(async () => {
        await tokens(50, 'rolled-back');
        throw new Error('the business change failed');
      }),
    ).rejects.toThrow('the business change failed');
    const n = await h.db.execute(
      sql`select count(*)::int as n from license.usage_events where tenant_id = ${hotel.tenantId} and idempotency_key = 'rolled-back'`,
    );
    expect(n.rows[0]).toEqual({ n: 0 });
  });

  it('announces a reached limit once per period', async () => {
    expect(await limitEvents()).toEqual([]);
    await tokens(500, 'call-3'); // 1100 ≥ 1000 SOFT for the month
    await tokens(100, 'call-4');
    const events = await limitEvents();
    expect(events).toHaveLength(1);
    expect(events[0]!.payload).toEqual({
      metric_code: 'AI_INPUT_TOKENS',
      enforcement: 'SOFT',
      period_start: month,
      limit_value: 1000,
      used: 1100,
    });
    // SOFT never stops anything.
    expect(await usage.withinLimit(hotel.tenantId, hotel.propertyId, 'AI_INPUT_TOKENS')).toBe(true);
  });

  it('reports a HARD counter limit used up for the period', async () => {
    await tokens(3800, 'call-5'); // the property's day: 5000
    expect(await usage.withinLimit(hotel.tenantId, hotel.propertyId, 'AI_INPUT_TOKENS')).toBe(
      false,
    );
    // The tenant-wide view has no HARD limit.
    expect(await usage.withinLimit(hotel.tenantId, null, 'AI_INPUT_TOKENS')).toBe(true);
    const hard = (await limitEvents()).find(
      (e) => (e.payload as { enforcement: string }).enforcement === 'HARD',
    );
    expect(hard?.property_id).toBe(hotel.propertyId);
  });

  it('samples gauges once a day and keeps the maximum', async () => {
    let level = 2;
    usage.register({
      metric: 'ACTIVE_STAFF',
      sample: async (tenantId) =>
        tenantId === hotel.tenantId ? [{ propertyId: null, value: level }] : [],
    });
    expect(() => usage.register({ metric: 'AI_INPUT_TOKENS', sample: async () => [] })).toThrow(
      /not a gauge/,
    );
    await h.db.execute(
      sql`delete from license.usage_collector_cursors where collector = 'gauge:ACTIVE_STAFF'`,
    );
    await usage.sampleGauges();
    level = 9;
    await usage.sampleGauges(); // same day: skipped
    expect(await aggregates(hotel.tenantId, 'ACTIVE_STAFF')).toEqual([
      { granularity: 'DAY', q: 2 },
      { granularity: 'MONTH', q: 2 },
    ]);
    await usage.record({
      tenantId: hotel.tenantId,
      propertyId: null,
      metric: 'ACTIVE_STAFF',
      quantity: 4,
      source: 'test',
      idempotencyKey: 'staff-4',
    });
    expect((await aggregates(hotel.tenantId, 'ACTIVE_STAFF')).map((a) => a.q)).toEqual([4, 4]);
    const gaugeNotice = (await limitEvents()).find(
      (e) => (e.payload as { metric_code: string }).metric_code === 'ACTIVE_STAFF',
    );
    expect(gaugeNotice?.payload).toMatchObject({
      enforcement: 'SOFT',
      period_start: null,
      used: 4,
    });
  });

  it('reports usage to the control plane and to the tenant, never another tenant’s', async () => {
    const from = month.slice(0, 10);
    const report = await h
      .http()
      .get(
        `/control/tenants/${hotel.tenantId}/usage?granularity=MONTH&from=${from}&to=${nextMonth}&metric=AI_INPUT_TOKENS`,
      )
      .set('X-Test-Actor', ADMIN)
      .expect(200);
    expect(report.body.rows).toEqual([
      { metricCode: 'AI_INPUT_TOKENS', periodStart: month, quantity: 5000 },
    ]);
    const own = await h
      .http()
      .get(`/tenants/${hotel.tenantId}/license`)
      .set('X-Test-Actor', staff(gmId, hotel.tenantId))
      .expect(200);
    expect(own.body.usage).toEqual(
      expect.arrayContaining([
        { metricCode: 'AI_INPUT_TOKENS', periodStart: month, quantity: 5000 },
      ]),
    );
    const other = await createTenant(h, `UO${stamp}`);
    const theirs = await h
      .http()
      .get(`/control/tenants/${other.tenantId}/usage?from=${from}&to=${nextMonth}`)
      .set('X-Test-Actor', ADMIN)
      .expect(200);
    expect(theirs.body.rows).toEqual([]);
  });

  it('purges measured events past retention and keeps the aggregates', async () => {
    await h.db.execute(
      sql`insert into license.usage_events (id, tenant_id, metric_code, quantity, occurred_at, source, idempotency_key) values (${newId()}, ${hotel.tenantId}, 'API_CALLS', 1, now() - interval '500 days', 'test', 'ancient')`,
    );
    expect(await usage.purgeEvents()).toBeGreaterThanOrEqual(1);
    const left = await h.db.execute(
      sql`select count(*)::int as n from license.usage_events where tenant_id = ${hotel.tenantId} and idempotency_key = 'ancient'`,
    );
    expect(left.rows[0]).toEqual({ n: 0 });
    expect((await aggregates(hotel.tenantId, 'AI_INPUT_TOKENS')).length).toBe(2);
  });
});
