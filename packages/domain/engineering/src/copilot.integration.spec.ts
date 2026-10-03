import { sql } from 'drizzle-orm';
import { newId } from '@hotella/platform-database';
import { RequestContext } from '@hotella/platform-observability';
import { infraSkipReason, needsInfra, readTestInfra } from '@hotella/platform-testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ToolContext } from '@hotella/domain-ai/public';
import { EngineeringAiTools } from './application/ai-tools';
import {
  ASKS,
  createHotel,
  type EngHarness,
  type Hotel,
  SEARCHES,
  staff,
  startEngineeringApp,
} from './testing/harness';

const stamp = Date.now().toString(36).toUpperCase();

describe.skipIf(needsInfra())(`Engineering Copilot tools (${infraSkipReason()})`, () => {
  const url = readTestInfra().databaseUrl!;
  const gmId = newId();
  const readerId = newId();
  const STAFF = [
    'org.property.read',
    'org.property.manage',
    'org.location.manage',
    'org.department.manage',
    'eng.asset.read',
    'eng.asset.manage',
    'eng.config.manage',
    'eng.work_order.read',
    'eng.work_order.manage',
    'task.read',
    'task.accept',
    'task.complete',
  ];
  let h: EngHarness;
  let hotel: Hotel;
  let other: Hotel;
  let unit504: string;
  let unit505: string;
  let foreignUnit: string;
  let manual: string;
  const gm = () => staff(gmId, hotel.tenantId);
  const base = () => `/properties/${hotel.propertyId}/eng`;
  const tools = () => h.app.get(EngineeringAiTools);
  /** Runs a tool handler as the executor would: in the hotel's tenant context, after the gate. */
  const call = <I>(
    def: { handle: (args: I, ctx: ToolContext) => Promise<unknown> },
    args: I,
    at: Hotel = hotel,
    locale = 'en',
  ) =>
    h.app.get(RequestContext).run({ tenant_id: at.tenantId, property_id: at.propertyId }, () =>
      def.handle(args, {
        tenantId: at.tenantId,
        propertyId: at.propertyId,
        executionId: newId(),
        agentCode: 'ENGINEERING_COPILOT',
        locale,
        guest: null,
        conversationId: null,
      }),
    ) as Promise<Record<string, unknown>>;

  beforeAll(async () => {
    h = await startEngineeringApp(url, 'hotella_app_eng_ai', {
      [gmId]: STAFF,
      [readerId]: ['eng.work_order.read'],
    });
    hotel = await createHotel(h, `engc-a-${stamp}`, gmId);
    other = await createHotel(h, `engc-b-${stamp}`, gmId, ['900']);
    await h
      .http()
      .post(`/properties/${hotel.propertyId}/departments`)
      .set('X-Test-Actor', gm())
      .send({ code: 'ENG', translations: [{ locale: 'en', name: 'Engineering' }] })
      .expect(201);
    await h.http().post('/eng/failure-codes/starter').set('X-Test-Actor', gm()).expect(201);
    const type = (
      await h
        .http()
        .post('/eng/asset-types')
        .set('X-Test-Actor', gm())
        .send({
          code: 'FCU',
          translations: [
            { locale: 'en', name: 'Fan-coil unit' },
            { locale: 'ar', name: 'وحدة ملف مروحة' },
          ],
        })
        .expect(201)
    ).body as { id: string };
    const model = (
      await h
        .http()
        .post('/eng/asset-models')
        .set('X-Test-Actor', gm())
        .send({ assetTypeId: type.id, manufacturer: 'Carrier', modelCode: '42N' })
        .expect(201)
    ).body as { id: string };
    const unit = async (at: Hotel, room: string, extra: object = {}) =>
      (
        await h
          .http()
          .post(`/properties/${at.propertyId}/eng/assets`)
          .set('X-Test-Actor', staff(gmId, at.tenantId))
          .send({
            assetNumber: `FCU-${room}`,
            assetTypeId: type.id,
            assetModelId: model.id,
            locationId: at.rooms[room],
            name: `Room ${room} fan-coil`,
            ...extra,
          })
          .expect(201)
      ).body.id as string;
    unit504 = await unit(hotel, '504', { warrantyUntil: '2099-12-31' });
    unit505 = await unit(hotel, '505');
    // Another tenant's hotel has its own taxonomy.
    const foreignType = (
      await h
        .http()
        .post('/eng/asset-types')
        .set('X-Test-Actor', staff(gmId, other.tenantId))
        .send({ code: 'FCU', translations: [{ locale: 'en', name: 'Fan-coil unit' }] })
        .expect(201)
    ).body as { id: string };
    foreignUnit = await unit(other, '900', {
      assetTypeId: foreignType.id,
      assetModelId: undefined,
    });

    // One closed corrective order on the twin unit: the history the copilot counts.
    const order = (
      await h
        .http()
        .post(`${base()}/work-orders`)
        .set('X-Test-Actor', gm())
        .send({ type: 'CORRECTIVE', assetId: unit505, symptomCode: 'NOT_COOLING' })
        .expect(201)
    ).body as { id: string; version: number };
    await h
      .http()
      .patch(`${base()}/work-orders/${order.id}`)
      .set('X-Test-Actor', gm())
      .send({
        version: order.version,
        diagnosis: 'Capacitor swollen',
        failureModeCode: 'COMPRESSOR_NOT_STARTING',
        causeCode: 'CAPACITOR_FAILED',
        downtimeStartedAt: '2026-10-03T10:00:00Z',
      })
      .expect(200);
    await h
      .http()
      .post(`${base()}/work-orders/${order.id}/complete`)
      .set('X-Test-Actor', gm())
      .send({ resolutionCode: 'CAPACITOR_REPLACED', downtimeEndedAt: '2026-10-03T11:00:00Z' })
      .expect(200);

    manual = newId();
    await h.db
      .execute(sql`insert into knowledge.documents (id, tenant_id, property_id, kind, title, status)
      values (${manual}, ${hotel.tenantId}, null, 'MANUAL', 'Carrier 42N service manual', 'ACTIVE')`);
    await h
      .http()
      .post(`${base()}/asset-documents`)
      .set('X-Test-Actor', gm())
      .send({ knowledgeDocumentId: manual, kind: 'MANUAL', assetModelId: model.id })
      .expect(201);
  });
  afterAll(() => h?.app.close());

  it('finds the equipment of a room or by name, only at this property', async () => {
    const byRoom = await call(tools().findAssets(), { roomNumber: '504' });
    expect(byRoom.assets).toEqual([
      expect.objectContaining({
        asset_id: unit504,
        number: 'FCU-504',
        type: 'Fan-coil unit',
        room: '504',
      }),
    ]);
    const byName = await call(tools().findAssets(), { text: 'fcu' }, hotel, 'ar');
    expect((byName.assets as Array<{ number: string; type: string }>).map((a) => a.number)).toEqual(
      ['FCU-504', 'FCU-505'],
    );
    expect((byName.assets as Array<{ type: string }>)[0]!.type).toBe('وحدة ملف مروحة');
    // A wildcard is a literal, never a way to list everything.
    expect((await call(tools().findAssets(), { text: '%%' })).assets).toEqual([]);
    expect(tools().findAssets().input.safeParse({}).success).toBe(false);
  });

  it('reads an asset’s history with named failure codes and downtime, never another hotel’s asset', async () => {
    const history = await call(tools().assetHistory(), { assetId: unit505 });
    expect(history.asset).toMatchObject({
      number: 'FCU-505',
      model: { manufacturer: 'Carrier', model_code: '42N' },
      under_warranty: false,
      room: '505',
    });
    expect(history.work_orders).toEqual([
      expect.objectContaining({
        type: 'CORRECTIVE',
        status: 'DONE',
        failure_mode: { code: 'COMPRESSOR_NOT_STARTING', name: expect.any(String) },
        resolution: { code: 'CAPACITOR_REPLACED', name: expect.any(String) },
        downtime_minutes: 60,
        diagnosis: 'Capacitor swollen',
      }),
    ]);
    expect((await call(tools().assetHistory(), { assetId: unit504 })).asset).toMatchObject({
      under_warranty: true,
    });
    await expect(call(tools().assetHistory(), { assetId: foreignUnit })).rejects.toMatchObject({
      code: 'eng.asset.not_found',
    });
    await expect(call(tools().assetHistory(), { assetId: 'not-a-uuid' })).rejects.toMatchObject({
      code: 'eng.asset.not_found',
    });
  });

  it('counts what failed on the same model, as history', async () => {
    const stats = await call(tools().likelyFailureModes(), { assetId: unit504 });
    expect(stats).toMatchObject({
      basis: 'MODEL',
      closed_work_orders: 1,
      failure_modes: [{ code: 'COMPRESSOR_NOT_STARTING', count: 1, share: 1 }],
      causes: [{ code: 'CAPACITOR_FAILED', count: 1 }],
      resolutions: [{ code: 'CAPACITOR_REPLACED', count: 1 }],
    });
  });

  it('searches the asset’s own manuals first, then the hotel’s staff documents', async () => {
    SEARCHES.length = 0;
    const found = await call(tools().searchManuals(), { query: 'reset', assetId: unit504 });
    expect(found).toMatchObject({
      scope: 'ASSET',
      passages: [{ document_id: manual, title: 'Linked manual', version_no: 1 }],
    });
    expect(SEARCHES[0]).toMatchObject({
      tenantId: hotel.tenantId,
      propertyId: hotel.propertyId,
      audience: 'STAFF',
      maxClassification: 'INTERNAL',
      documentIds: [manual],
    });
    SEARCHES.length = 0;
    const general = await call(tools().searchManuals(), { query: 'chiller start-up' });
    expect(general).toMatchObject({ scope: 'PROPERTY', passages: [] });
    expect(SEARCHES).toMatchObject([{ documentIds: null }]);
  });

  it('the copilot endpoint asks the assistant with the open asset as focus, for people who may read both', async () => {
    ASKS.length = 0;
    const answer = await h
      .http()
      .post(`${base()}/copilot`)
      .set('X-Test-Actor', gm())
      .send({ question: 'Why does this unit keep failing?', assetId: unit504 })
      .expect(200);
    expect(answer.body).toMatchObject({
      outcome: 'ANSWERED',
      answer: 'Check the capacitor first.',
    });
    expect(ASKS).toEqual([
      expect.objectContaining({
        tenantId: hotel.tenantId,
        propertyId: hotel.propertyId,
        agentCode: 'ENGINEERING_COPILOT',
        userId: gmId,
        question: 'Why does this unit keep failing?',
        focus: [
          expect.objectContaining({
            dataClass: 'INTERNAL',
            text: expect.stringContaining('FCU-504'),
          }),
        ],
      }),
    ]);
    // Another hotel's asset is not found; reading work without reading assets is not enough.
    await h
      .http()
      .post(`${base()}/copilot`)
      .set('X-Test-Actor', gm())
      .send({ question: 'And this one?', assetId: foreignUnit })
      .expect(404);
    await h
      .http()
      .post(`${base()}/copilot`)
      .set('X-Test-Actor', staff(readerId, hotel.tenantId))
      .send({ question: 'Anything?' })
      .expect(403);
    expect(ASKS).toHaveLength(1);
  });
});
