import { sql } from 'drizzle-orm';
import { newId } from '@hotella/platform-database';
import { infraSkipReason, needsInfra, readTestInfra } from '@hotella/platform-testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ENGINEERING_API, type EngineeringPublicApi } from './public';
import {
  createHotel,
  type EngHarness,
  type Hotel,
  staff,
  startEngineeringApp,
} from './testing/harness';

const stamp = Date.now().toString(36).toUpperCase();

describe.skipIf(needsInfra())(`Engineering asset registry (${infraSkipReason()})`, () => {
  const url = readTestInfra().databaseUrl!;
  const gmId = newId();
  const STAFF = [
    'org.property.read',
    'org.property.manage',
    'org.location.manage',
    'eng.asset.read',
    'eng.asset.manage',
    'eng.config.manage',
  ];
  let h: EngHarness;
  let hotel: Hotel;
  let other: Hotel;
  const gm = (tenantId = hotel.tenantId) => staff(gmId, tenantId);
  const base = () => `/properties/${hotel.propertyId}/eng`;
  let fcu: { id: string; version: number };
  let model: { id: string };

  beforeAll(async () => {
    h = await startEngineeringApp(url, 'hotella_app_eng', { [gmId]: STAFF });
    hotel = await createHotel(h, `eng-a-${stamp}`, gmId);
    other = await createHotel(h, `eng-b-${stamp}`, gmId, ['900']);
  });
  afterAll(() => h?.app.close());

  it('defines equipment types with controlled properties and names in both languages', async () => {
    const created = await h
      .http()
      .post('/eng/asset-types')
      .set('X-Test-Actor', gm())
      .send({
        code: 'FCU',
        translations: [
          { locale: 'en', name: 'Fan-coil unit' },
          { locale: 'ar', name: 'وحدة ملف المروحة' },
        ],
        properties: [
          { key: 'capacity', type: 'NUMBER', unit: 'kW', min: 0, max: 50, required: true },
          { key: 'refrigerant', type: 'CHOICE', options: ['R32', 'R410A'] },
        ],
      })
      .expect(201);
    fcu = created.body;
    expect(created.body.translations).toHaveLength(2);
    await h
      .http()
      .post('/eng/asset-types')
      .set('X-Test-Actor', gm())
      .send({ code: 'FCU', translations: [{ locale: 'en', name: 'Again' }] })
      .expect(409);
    // A new required field would make existing units invalid; an optional one is fine.
    await h
      .http()
      .patch(`/eng/asset-types/${fcu.id}`)
      .set('X-Test-Actor', gm())
      .send({
        version: fcu.version,
        properties: [...created.body.properties, { key: 'zone', type: 'TEXT', required: true }],
      })
      .expect(409);
    fcu = (
      await h
        .http()
        .patch(`/eng/asset-types/${fcu.id}`)
        .set('X-Test-Actor', gm())
        .send({
          version: fcu.version,
          properties: [...created.body.properties, { key: 'zone', type: 'TEXT' }],
        })
        .expect(200)
    ).body;
    model = (
      await h
        .http()
        .post('/eng/asset-models')
        .set('X-Test-Actor', gm())
        .send({
          assetTypeId: fcu.id,
          manufacturer: 'Carrier',
          modelCode: '42N-03',
          expectedLifeMonths: 120,
        })
        .expect(201)
    ).body;
  });

  it('registers equipment at a room with its parts; values are checked against the type', async () => {
    const unit = (
      await h
        .http()
        .post(`${base()}/assets`)
        .set('X-Test-Actor', gm())
        .send({
          assetNumber: 'FCU-504',
          assetTypeId: fcu.id,
          assetModelId: model.id,
          locationId: hotel.rooms['504'],
          name: 'Room 504 fan-coil',
          criticality: 'HIGH',
          warrantyUntil: '2027-12-31',
          properties: { capacity: 3.5, refrigerant: 'R32' },
        })
        .expect(201)
    ).body;
    const bad = await h
      .http()
      .post(`${base()}/assets`)
      .set('X-Test-Actor', gm())
      .send({
        assetNumber: 'FCU-505',
        assetTypeId: fcu.id,
        locationId: hotel.rooms['505'],
        name: 'Room 505 fan-coil',
        properties: { refrigerant: 'R22', colour: 'red' },
      })
      .expect(422);
    expect(bad.body.code).toBe('eng.asset.invalid_properties');
    await h
      .http()
      .post(`${base()}/assets`)
      .set('X-Test-Actor', gm())
      .send({
        assetNumber: 'FCU-504',
        assetTypeId: fcu.id,
        locationId: hotel.rooms['505'],
        name: 'Duplicate number',
        properties: { capacity: 2 },
      })
      .expect(409);
    // Another property's room is not a place for this property's equipment.
    await h
      .http()
      .post(`${base()}/assets`)
      .set('X-Test-Actor', gm())
      .send({
        assetNumber: 'FCU-900',
        assetTypeId: fcu.id,
        locationId: other.rooms['900'],
        name: 'Elsewhere',
        properties: { capacity: 2 },
      })
      .expect(404);

    const motor = (
      await h
        .http()
        .post(`${base()}/assets`)
        .set('X-Test-Actor', gm())
        .send({
          assetNumber: 'FCU-504-M',
          assetTypeId: fcu.id,
          locationId: hotel.rooms['504'],
          parentAssetId: unit.id,
          name: 'Fan motor',
          properties: { capacity: 0.2 },
        })
        .expect(201)
    ).body;
    // A unit cannot become a part of its own part.
    await h
      .http()
      .patch(`${base()}/assets/${unit.id}`)
      .set('X-Test-Actor', gm())
      .send({ version: unit.version, parentAssetId: motor.id })
      .expect(409);
    const detail = (
      await h.http().get(`${base()}/assets/${unit.id}`).set('X-Test-Actor', gm()).expect(200)
    ).body;
    expect(detail.parts.map((p: { assetNumber: string }) => p.assetNumber)).toEqual(['FCU-504-M']);
    expect(
      (await h.http().get(`${base()}/assets/${motor.id}`).set('X-Test-Actor', gm()).expect(200))
        .body.ancestors,
    ).toEqual([unit.id]);

    const api = h.app.get<EngineeringPublicApi>(ENGINEERING_API);
    expect(
      (await api.assetsAtLocation(hotel.tenantId, hotel.propertyId, hotel.rooms['504']!)).map(
        (a) => a.assetNumber,
      ),
    ).toEqual(['FCU-504', 'FCU-504-M']);
    await h
      .http()
      .patch(`${base()}/assets/${motor.id}`)
      .set('X-Test-Actor', gm())
      .send({ version: motor.version, status: 'RETIRED' })
      .expect(200);
    expect(
      (await api.assetsAtLocation(hotel.tenantId, hotel.propertyId, hotel.rooms['504']!)).map(
        (a) => a.assetNumber,
      ),
    ).toEqual(['FCU-504']);
    const [audit] = (
      await h.db.execute(
        sql`select count(*)::int as n from audit.audit_log where tenant_id = ${hotel.tenantId} and action like 'eng.asset.%'`,
      )
    ).rows as Array<{ n: number }>;
    expect(audit!.n).toBe(3);
  });

  it('links the manual of the model, not another property’s document', async () => {
    const manual = newId();
    const foreign = newId();
    await h.db
      .execute(sql`insert into knowledge.documents (id, tenant_id, property_id, kind, title, status)
      values (${manual}, ${hotel.tenantId}, null, 'MANUAL', 'Carrier 42N service manual', 'ACTIVE'),
             (${foreign}, ${other.tenantId}, ${other.propertyId}, 'MANUAL', 'Another hotel', 'ACTIVE')`);
    const linked = await h
      .http()
      .post(`${base()}/asset-documents`)
      .set('X-Test-Actor', gm())
      .send({ knowledgeDocumentId: manual, kind: 'MANUAL', assetModelId: model.id })
      .expect(201);
    expect(linked.body.title).toBe('Carrier 42N service manual');
    await h
      .http()
      .post(`${base()}/asset-documents`)
      .set('X-Test-Actor', gm())
      .send({ knowledgeDocumentId: manual, kind: 'MANUAL', assetModelId: model.id })
      .expect(409);
    await h
      .http()
      .post(`${base()}/asset-documents`)
      .set('X-Test-Actor', gm())
      .send({ knowledgeDocumentId: foreign, kind: 'MANUAL', assetModelId: model.id })
      .expect(404);
    // The unit inherits its model's manual.
    const [unit] = (
      await h
        .http()
        .get(`${base()}/assets?locationId=${hotel.rooms['504']}`)
        .set('X-Test-Actor', gm())
        .expect(200)
    ).body as Array<{ id: string }>;
    const detail = (
      await h.http().get(`${base()}/assets/${unit!.id}`).set('X-Test-Actor', gm()).expect(200)
    ).body;
    expect(
      detail.documents.map((d: { knowledgeDocumentId: string }) => d.knowledgeDocumentId),
    ).toEqual([manual]);
  });

  it('imports the failure taxonomy once, in English and Arabic, and adds the hotel’s own codes', async () => {
    const first = await h
      .http()
      .post('/eng/failure-codes/starter')
      .set('X-Test-Actor', gm())
      .expect(201);
    expect(first.body.created).toContain('SYMPTOM:NOT_COOLING');
    const again = await h
      .http()
      .post('/eng/failure-codes/starter')
      .set('X-Test-Actor', gm())
      .expect(201);
    expect(again.body.created).toEqual([]);
    await h
      .http()
      .post('/eng/failure-codes')
      .set('X-Test-Actor', gm())
      .send({
        kind: 'CAUSE',
        code: 'SAND_INGRESS',
        assetTypeId: fcu.id,
        translations: [
          { locale: 'en', name: 'Sand in the unit' },
          { locale: 'ar', name: 'دخول رمال إلى الوحدة' },
        ],
      })
      .expect(201);
    const causes = (
      await h.http().get('/eng/failure-codes?kind=CAUSE').set('X-Test-Actor', gm()).expect(200)
    ).body as Array<{ code: string; translations: Array<{ locale: string; name: string }> }>;
    expect(causes.map((c) => c.code)).toContain('SAND_INGRESS');
    expect(causes.find((c) => c.code === 'CAPACITOR_FAILED')!.translations).toEqual([
      { locale: 'ar', name: 'تلف المكثف' },
      { locale: 'en', name: 'Capacitor failed' },
    ]);
  });

  it('isolates tenants: another tenant’s equipment, types and codes are not found, and row-level security hides them', async () => {
    const [unit] = (await h.http().get(`${base()}/assets`).set('X-Test-Actor', gm()).expect(200))
      .body as Array<{ id: string }>;
    await h
      .http()
      .get(`/properties/${other.propertyId}/eng/assets/${unit!.id}`)
      .set('X-Test-Actor', gm(other.tenantId))
      .expect(404);
    await h.http().get(`${base()}/assets`).set('X-Test-Actor', gm(other.tenantId)).expect(404);
    expect(
      (await h.http().get('/eng/asset-types').set('X-Test-Actor', gm(other.tenantId)).expect(200))
        .body,
    ).toEqual([]);
    await h
      .http()
      .patch(`/eng/asset-types/${fcu.id}`)
      .set('X-Test-Actor', gm(other.tenantId))
      .send({ version: fcu.version, active: false })
      .expect(404);
    const leaked = await h.db.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.tenant_id', ${other.tenantId}, true)`);
      return (
        await tx.execute(
          sql`select (select count(*)::int from eng.assets where tenant_id = ${hotel.tenantId})
            + (select count(*)::int from eng.asset_types where tenant_id = ${hotel.tenantId})
            + (select count(*)::int from eng.failure_codes where tenant_id = ${hotel.tenantId}) as n`,
        )
      ).rows[0] as { n: number };
    });
    expect(leaked.n).toBe(0);
  });
});
