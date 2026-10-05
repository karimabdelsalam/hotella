import { sql } from 'drizzle-orm';
import type { EventEnvelope } from '@hotella/contracts-events';
import { IngestService } from '@hotella/domain-integrations';
import { newId } from '@hotella/platform-database';
import { infraSkipReason, needsInfra, readTestInfra } from '@hotella/platform-testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TelemetryService } from './application/telemetry.service';
import {
  createHotel,
  type EngHarness,
  type Hotel,
  staff,
  startEngineeringApp,
} from './testing/harness';

const stamp = Date.now().toString(36).toUpperCase();
const MINUTE = 60_000;

describe.skipIf(needsInfra())(`Building telemetry (${infraSkipReason()})`, () => {
  const url = readTestInfra().databaseUrl!;
  const gmId = newId();
  const STAFF = [
    'org.property.read',
    'org.property.manage',
    'org.location.manage',
    'org.department.manage',
    'eng.asset.read',
    'eng.asset.manage',
    'eng.config.manage',
    'eng.work_order.read',
    'eng.telemetry.read',
    'eng.telemetry.manage',
    'eng.telemetry.acknowledge',
    'integration.read',
    'integration.configure',
    'integration.mapping.confirm',
  ];
  let h: EngHarness;
  let hotel: Hotel;
  let other: Hotel;
  let instanceId: string;
  let chiller: { id: string };
  let supply: { id: string; version: number };
  let seq = 0;
  // Minute-aligned, half an hour ago: every sample is inside the accepted window.
  const T0 = Math.floor((Date.now() - 30 * MINUTE) / MINUTE) * MINUTE;
  const at = (minute: number, second = 0) =>
    new Date(T0 + minute * MINUTE + second * 1000).toISOString();
  const gm = (tenantId = hotel.tenantId) => staff(gmId, tenantId);
  const base = () => `/properties/${hotel.propertyId}/eng/telemetry`;
  const sqlRows = async <T>(q: ReturnType<typeof sql>) =>
    (await h.db.execute(q)).rows as unknown as T[];

  /** A BMS batch through the real ingest; the worker's consumer is played by calling the service with the event. */
  async function batch(samples: Array<{ point: string; value: number; at: string }>) {
    const ingest = h.app.get(IngestService);
    const result = await ingest.ingest(instanceId, {
      message_type: 'TELEMETRY_BATCH',
      source_message_id: `tb-${stamp}-${++seq}`,
      payload: { samples },
    });
    expect(result).toMatchObject({ outcome: 'accepted', status: 'PROCESSED' });
    const [row] = await sqlRows<{ envelope: EventEnvelope }>(
      sql`select envelope from platform.outbox where aggregate_type = 'integration_message' and aggregate_id = ${result.messageId}`,
    );
    expect(row!.envelope.event_type).toBe('integration.telemetry_batch.received');
    await h.app.get(TelemetryService).receive(row!.envelope);
    return result.messageId;
  }
  const alarms = async () =>
    (await h.http().get(`${base()}/alarms`).set('X-Test-Actor', gm()).expect(200)).body as Array<{
      id: string;
      ruleId: string;
      status: string;
      value: number | null;
      peak: number | null;
      workOrderId: string | null;
      version: number;
    }>;

  beforeAll(async () => {
    h = await startEngineeringApp(url, 'hotella_app_eng_telemetry', { [gmId]: STAFF });
    hotel = await createHotel(h, `engt-a-${stamp}`, gmId);
    other = await createHotel(h, `engt-b-${stamp}`, gmId, ['900']);
    await h
      .http()
      .post(`/properties/${hotel.propertyId}/departments`)
      .set('X-Test-Actor', gm())
      .send({ code: 'ENG', translations: [{ locale: 'en', name: 'Engineering' }] })
      .expect(201);
    const type = (
      await h
        .http()
        .post('/eng/asset-types')
        .set('X-Test-Actor', gm())
        .send({ code: 'CHILLER', translations: [{ locale: 'en', name: 'Chiller' }] })
        .expect(201)
    ).body as { id: string };
    chiller = (
      await h
        .http()
        .post(`/properties/${hotel.propertyId}/eng/assets`)
        .set('X-Test-Actor', gm())
        .send({
          assetNumber: 'CH-01',
          assetTypeId: type.id,
          locationId: hotel.rootId,
          name: 'Chiller 1',
          criticality: 'CRITICAL',
        })
        .expect(201)
    ).body;
    const integrations = `/properties/${hotel.propertyId}/integrations`;
    instanceId = (
      await h
        .http()
        .post(integrations)
        .set('X-Test-Actor', gm())
        .send({ connectorCode: 'BMS_STANDARD', name: 'BMS', capabilities: ['TELEMETRY_READ'] })
        .expect(201)
    ).body.id;
    await h
      .http()
      .patch(`${integrations}/${instanceId}`)
      .set('X-Test-Actor', gm())
      .send({ version: 1, status: 'ACTIVE' })
      .expect(200);
  });
  afterAll(() => h?.app.close());

  it('an unknown point is an integration exception, never guessed; registering it settles the exception', async () => {
    await batch([{ point: 'CH-1.SUPPLY_T', value: 6.5, at: at(0) }]);
    const open = await sqlRows<{ status: string; occurrences: number }>(
      sql`select status, occurrences from integration.integration_exceptions where instance_id = ${instanceId} and mapping_type = 'POINT' and external_code = 'CH-1.SUPPLY_T'`,
    );
    expect(open).toEqual([{ status: 'OPEN', occurrences: 1 }]);
    // Points are mapped in engineering, not through the integration mapping screen.
    const refused = await h
      .http()
      .post(`/properties/${hotel.propertyId}/integrations/${instanceId}/mappings`)
      .set('X-Test-Actor', gm())
      .send({ mappingType: 'POINT', externalCode: 'CH-1.SUPPLY_T', internalValue: chiller.id })
      .expect(422);
    expect(refused.body.code).toBe('integration.mapping.point_in_engineering');

    const unplaced = await h
      .http()
      .post(`${base()}/points`)
      .set('X-Test-Actor', gm())
      .send({ instanceId, externalCode: 'CH-1.SUPPLY_T', quantity: 'TEMPERATURE', unit: '°C' })
      .expect(400);
    expect(unplaced.body.code).toBe('platform.validation_failed');
    supply = (
      await h
        .http()
        .post(`${base()}/points`)
        .set('X-Test-Actor', gm())
        .send({
          instanceId,
          externalCode: 'CH-1.SUPPLY_T',
          name: 'Chilled water supply',
          assetId: chiller.id,
          quantity: 'TEMPERATURE',
          unit: '°C',
        })
        .expect(201)
    ).body;
    await h
      .http()
      .post(`${base()}/points`)
      .set('X-Test-Actor', gm())
      .send({
        instanceId,
        externalCode: 'CH-1.SUPPLY_T',
        assetId: chiller.id,
        quantity: 'TEMPERATURE',
        unit: '°C',
      })
      .expect(409);
    const settled = await sqlRows<{ status: string }>(
      sql`select status from integration.integration_exceptions where instance_id = ${instanceId} and mapping_type = 'POINT' and external_code = 'CH-1.SUPPLY_T'`,
    );
    expect(settled).toEqual([{ status: 'RESOLVED' }]);
  });

  it('keeps minute aggregates, not samples, and serves them back', async () => {
    await batch([
      { point: 'CH-1.SUPPLY_T', value: 6, at: at(1, 10) },
      { point: 'CH-1.SUPPLY_T', value: 7, at: at(1, 50) },
      { point: 'CH-1.SUPPLY_T', value: 8, at: at(1, 30) },
    ]);
    // A second batch for the same minute merges into it (out of order on purpose).
    await batch([{ point: 'CH-1.SUPPLY_T', value: 5, at: at(1, 5) }]);
    const minutes = await h
      .http()
      .get(`${base()}/points/${supply.id}/minutes`)
      .query({ from: at(0), to: at(5) })
      .set('X-Test-Actor', gm())
      .expect(200);
    expect(minutes.body).toEqual([
      expect.objectContaining({ minute: at(1), min: 5, max: 8, avg: 6.5, samples: 4, last: 7 }),
    ]);
    const points = await h.http().get(`${base()}/points`).set('X-Test-Actor', gm()).expect(200);
    expect(points.body[0]).toMatchObject({ lastValue: 7, lastAt: at(1, 50) });
    await h
      .http()
      .get(`${base()}/points/${supply.id}/minutes`)
      .query({ from: at(0), to: new Date(T0 + 2 * 24 * 60 * MINUTE).toISOString() })
      .set('X-Test-Actor', gm())
      .expect(400);
  });

  it('a threshold rule raises one alarm with an alert and predictive work, holds, and clears with hysteresis', async () => {
    const bad = await h
      .http()
      .post(`${base()}/rules`)
      .set('X-Test-Actor', gm())
      .send({
        pointId: supply.id,
        kind: 'THRESHOLD',
        params: { above: 8, clear_at: 9 },
        severity: 'CRITICAL',
      })
      .expect(400);
    expect(bad.body.code).toBe('eng.telemetry.rule_params_invalid');
    const rule = (
      await h
        .http()
        .post(`${base()}/rules`)
        .set('X-Test-Actor', gm())
        .send({
          pointId: supply.id,
          kind: 'THRESHOLD',
          params: { above: 8, clear_at: 7, for_minutes: 2 },
          severity: 'CRITICAL',
          action: 'WORK_ORDER',
        })
        .expect(201)
    ).body as { id: string; version: number };

    await batch([{ point: 'CH-1.SUPPLY_T', value: 9, at: at(2, 5) }]);
    expect((await alarms()).filter((a) => a.ruleId === rule.id)).toEqual([]);
    await batch([{ point: 'CH-1.SUPPLY_T', value: 9.5, at: at(3, 5) }]);
    const [alarm] = (await alarms()).filter((a) => a.ruleId === rule.id);
    expect(alarm).toMatchObject({ status: 'OPEN', value: 9.5, peak: 9.5 });
    expect(alarm!.workOrderId).not.toBeNull();

    const [order] = await sqlRows<{ type: string; source: string; asset_id: string }>(
      sql`select type, source, asset_id from eng.work_orders where id = ${alarm!.workOrderId}`,
    );
    expect(order).toEqual({ type: 'PREDICTIVE', source: 'TELEMETRY', asset_id: chiller.id });
    const alerts = await sqlRows<{ type: string; severity: string }>(
      sql`select type, severity from ops.alerts where dedupe_key = ${`telemetry:${alarm!.id}`}`,
    );
    expect(alerts).toEqual([{ type: 'TELEMETRY_ALARM', severity: 'CRITICAL' }]);
    const raised = await sqlRows<{ envelope: EventEnvelope }>(
      sql`select envelope from platform.outbox where aggregate_type = 'telemetry_alarm' and aggregate_id = ${alarm!.id} order by id`,
    );
    expect(raised.map((r) => r.envelope.event_type)).toEqual(['eng.telemetry_alarm.raised']);
    expect(raised[0]!.envelope.payload).toMatchObject({
      rule_kind: 'THRESHOLD',
      quantity: 'TEMPERATURE',
      severity: 'CRITICAL',
      asset_id: chiller.id,
      location_id: hotel.rootId,
      value: 9.5,
    });

    // Worse keeps the peak; between the clear level and the threshold the alarm holds.
    await batch([{ point: 'CH-1.SUPPLY_T', value: 10.5, at: at(4, 5) }]);
    await batch([{ point: 'CH-1.SUPPLY_T', value: 7.5, at: at(5, 5) }]);
    const [holding] = (await alarms()).filter((a) => a.ruleId === rule.id);
    expect(holding).toMatchObject({ status: 'OPEN', peak: 10.5 });

    const ack = await h
      .http()
      .post(`${base()}/alarms/${holding!.id}/acknowledge`)
      .set('X-Test-Actor', gm())
      .send({ version: holding!.version })
      .expect(200);
    expect(ack.body.status).toBe('ACKNOWLEDGED');

    await batch([{ point: 'CH-1.SUPPLY_T', value: 6.9, at: at(6, 5) }]);
    const [cleared] = (await alarms()).filter((a) => a.ruleId === rule.id);
    expect(cleared).toMatchObject({ status: 'CLEARED' });
    const events = await sqlRows<{ envelope: EventEnvelope }>(
      sql`select envelope from platform.outbox where aggregate_type = 'telemetry_alarm' and aggregate_id = ${alarm!.id} order by id`,
    );
    expect(events.map((r) => r.envelope.event_type)).toEqual([
      'eng.telemetry_alarm.raised',
      'eng.telemetry_alarm.cleared',
    ]);
    expect(events[1]!.envelope.payload).toMatchObject({ duration_s: 180 });

    // A rule is never edited (rule 9): it is retired, and retired once.
    await h
      .http()
      .post(`${base()}/rules/${rule.id}/retire`)
      .set('X-Test-Actor', gm())
      .send({ version: rule.version })
      .expect(200);
    await h
      .http()
      .post(`${base()}/rules/${rule.id}/retire`)
      .set('X-Test-Actor', gm())
      .send({ version: rule.version + 1 })
      .expect(409);
  });

  it('missing data raises from the sweep and clears with the next sample', async () => {
    const rule = (
      await h
        .http()
        .post(`${base()}/rules`)
        .set('X-Test-Actor', gm())
        .send({ pointId: supply.id, kind: 'MISSING', params: { minutes: 10 }, severity: 'WARNING' })
        .expect(201)
    ).body as { id: string };
    const telemetry = h.app.get(TelemetryService);
    // Last sample at minute 6: quiet until minute 16, missing from minute 17.
    await telemetry.sweep(new Date(T0 + 16 * MINUTE));
    expect((await alarms()).filter((a) => a.ruleId === rule.id)).toEqual([]);
    await telemetry.sweep(new Date(T0 + 17 * MINUTE));
    const [missing] = (await alarms()).filter((a) => a.ruleId === rule.id);
    expect(missing).toMatchObject({ status: 'OPEN', value: null, workOrderId: null });
    await telemetry.sweep(new Date(T0 + 18 * MINUTE));
    expect((await alarms()).filter((a) => a.ruleId === rule.id)).toHaveLength(1);
    await batch([{ point: 'CH-1.SUPPLY_T', value: 6.8, at: at(19, 1) }]);
    const [back] = (await alarms()).filter((a) => a.ruleId === rule.id);
    expect(back).toMatchObject({ status: 'CLEARED' });
  });

  it('an ignored point keeps nothing; samples from the future are dropped', async () => {
    await h
      .http()
      .patch(`${base()}/points/${supply.id}`)
      .set('X-Test-Actor', gm())
      .send({ version: supply.version, status: 'IGNORED' })
      .expect(200);
    await batch([{ point: 'CH-1.SUPPLY_T', value: 50, at: at(20, 1) }]);
    await h
      .http()
      .patch(`${base()}/points/${supply.id}`)
      .set('X-Test-Actor', gm())
      .send({ version: supply.version + 1, status: 'ACTIVE' })
      .expect(200);
    await batch([
      {
        point: 'CH-1.SUPPLY_T',
        value: 60,
        at: new Date(Date.now() + 3 * 86_400_000).toISOString(),
      },
    ]);
    const minutes = await h
      .http()
      .get(`${base()}/points/${supply.id}/minutes`)
      .query({ from: at(19), to: at(24 * 60 - 1) })
      .set('X-Test-Actor', gm())
      .expect(200);
    expect(minutes.body.map((m: { max: number }) => m.max)).toEqual([6.8]);
  });

  it('another hotel sees none of it', async () => {
    const outsider = gm(other.tenantId);
    await h.http().get(`${base()}/points`).set('X-Test-Actor', outsider).expect(404);
    await h
      .http()
      .get(`${base()}/points/${supply.id}/minutes`)
      .query({ from: at(0), to: at(5) })
      .set('X-Test-Actor', outsider)
      .expect(404);
    const own = await h
      .http()
      .get(`/properties/${other.propertyId}/eng/telemetry/alarms`)
      .set('X-Test-Actor', outsider)
      .expect(200);
    expect(own.body).toEqual([]);
    await h
      .http()
      .get(`/properties/${other.propertyId}/eng/telemetry/points/${supply.id}/minutes`)
      .query({ from: at(0), to: at(5) })
      .set('X-Test-Actor', outsider)
      .expect(404);
  });
});
