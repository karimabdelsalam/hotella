import { sql } from 'drizzle-orm';
import {
  createEnvelope,
  type EventEnvelope,
  WorkItemStatusChanged,
} from '@hotella/contracts-events';
import { OPERATIONS_API, type OperationsPublicApi } from '@hotella/domain-operations/public';
import { newId } from '@hotella/platform-database';
import { infraSkipReason, needsInfra, readTestInfra } from '@hotella/platform-testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { INSPECTION_FINDING_KIND, InspectionService } from './application/inspection.service';
import { INSPECTION_API, type InspectionPublicApi } from './public';
import {
  ASSETS,
  createHotel,
  type Hotel,
  type InspectionHarness,
  staff,
  startInspectionApp,
} from './testing/harness';

const stamp = Date.now().toString(36).toUpperCase();
/** A real 1×1 PNG. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

const both = (en: string, ar: string) => [
  { locale: 'en', label: en },
  { locale: 'ar', label: ar },
];
const CHECKLIST = {
  sections: [
    {
      code: 'EQUIPMENT',
      titles: [
        { locale: 'en', title: 'Equipment' },
        { locale: 'ar', title: 'المعدات' },
      ],
      items: [
        {
          code: 'EXTINGUISHER',
          rule: { kind: 'PASS_FAIL', failSeverity: 'CRITICAL' },
          labels: both('Extinguisher charged and sealed', 'طفاية الحريق مشحونة ومختومة'),
        },
        {
          code: 'SIGNAGE',
          rule: { kind: 'YES_NO', failSeverity: 'MINOR' },
          labels: both('Exit signs lit', 'علامات الخروج مضاءة'),
        },
        {
          code: 'SURFACES',
          rule: {
            kind: 'MULTI_SELECT',
            options: ['OK', 'DUST', 'MOULD'],
            failOptions: ['MOULD'],
            failSeverity: 'MAJOR',
          },
          labels: [
            {
              locale: 'en',
              label: 'Surfaces',
              optionLabels: { OK: 'Clean', DUST: 'Dust', MOULD: 'Mould' },
            },
            {
              locale: 'ar',
              label: 'الأسطح',
              optionLabels: { OK: 'نظيفة', DUST: 'غبار', MOULD: 'عفن' },
            },
          ],
        },
        {
          code: 'PHOTO',
          rule: { kind: 'PHOTO', required: false, failSeverity: 'INFO' },
          labels: both('Photo of the panel', 'صورة اللوحة'),
        },
        {
          code: 'NOTES',
          rule: { kind: 'TEXT', required: false, failSeverity: 'INFO' },
          labels: both('Notes', 'ملاحظات'),
        },
      ],
    },
  ],
};

describe.skipIf(needsInfra())(`Inspection engine (${infraSkipReason()})`, () => {
  const url = readTestInfra().databaseUrl!;
  const gmId = newId();
  const supervisorId = newId();
  const STAFF = [
    'org.property.read',
    'org.property.manage',
    'org.location.manage',
    'org.department.manage',
    'inspection.template.manage',
    'inspection.perform',
    'inspection.read',
    'task.read',
  ];
  let h: InspectionHarness;
  let hotel: Hotel;
  let other: Hotel;
  let templateId: string;
  let v1: string;
  let inspectionId: string;
  const gm = () => staff(gmId, hotel.tenantId);
  const base = () => `/properties/${hotel.propertyId}`;
  const outbox = async (type: string) =>
    (
      (
        await h.db.execute(
          sql`select envelope from platform.outbox where tenant_id = ${hotel.tenantId} and event_type = ${type} order by id`,
        )
      ).rows as Array<{ envelope: EventEnvelope }>
    ).map((r) => r.envelope.payload as Record<string, unknown>);
  const answer = (id: string, itemCode: string, value: object, actor = gm()) =>
    h
      .http()
      .put(`${base()}/inspections/${id}/answers`)
      .set('X-Test-Actor', actor)
      .send({ itemCode, answer: value });

  beforeAll(async () => {
    h = await startInspectionApp(url, 'hotella_app_inspection', {
      [gmId]: STAFF,
      [supervisorId]: ['inspection.read'],
    });
    hotel = await createHotel(h, `insp-a-${stamp}`, gmId, ['504']);
    other = await createHotel(h, `insp-b-${stamp}`, gmId, ['900']);
    await h
      .http()
      .post(`${base()}/departments`)
      .set('X-Test-Actor', gm())
      .send({ code: 'ENG', translations: [{ locale: 'en', name: 'Engineering' }] })
      .expect(201);
  });
  afterAll(() => h?.app.close());

  it('writes a checklist as a draft, refuses bad rules, publishes it, and never changes it again', async () => {
    const bad = await h
      .http()
      .post('/inspection/templates')
      .set('X-Test-Actor', gm())
      .send({
        code: 'BAD',
        scope: 'AREA',
        departmentCode: 'ENG',
        names: [{ locale: 'en', name: 'Bad' }],
        sections: [
          {
            code: 'SECTION',
            titles: [{ locale: 'en', title: 'Section' }],
            items: [
              {
                code: 'ITEM',
                rule: { kind: 'MULTI_SELECT', options: ['AA'], failOptions: ['BB'] },
                labels: [{ locale: 'en', label: 'Item' }],
              },
            ],
          },
        ],
      })
      .expect(201);
    const refused = await h
      .http()
      .post(`/inspection/templates/versions/${bad.body.draftVersionId}/publish`)
      .set('X-Test-Actor', gm())
      .expect(422);
    expect(refused.body.code).toBe('inspection.item.invalid_rule');

    const created = await h
      .http()
      .post('/inspection/templates')
      .set('X-Test-Actor', gm())
      .send({
        code: 'FIRE_SAFETY',
        scope: 'AREA',
        departmentCode: 'ENG',
        names: [
          { locale: 'en', name: 'Fire safety round' },
          { locale: 'ar', name: 'جولة السلامة من الحريق' },
        ],
        ...CHECKLIST,
      })
      .expect(201);
    templateId = created.body.id;
    v1 = created.body.draftVersionId;
    await h
      .http()
      .post('/inspection/templates')
      .set('X-Test-Actor', gm())
      .send({
        code: 'FIRE_SAFETY',
        scope: 'AREA',
        departmentCode: 'ENG',
        names: [{ locale: 'en', name: 'Again' }],
        ...CHECKLIST,
      })
      .expect(409);
    // Not published yet: nobody can start it.
    await h
      .http()
      .post(`${base()}/inspections`)
      .set('X-Test-Actor', gm())
      .send({ templateId, locationId: hotel.rooms['504'] })
      .expect(409);
    const published = await h
      .http()
      .post(`/inspection/templates/versions/${v1}/publish`)
      .set('X-Test-Actor', gm())
      .expect(200);
    expect(published.body).toMatchObject({ status: 'PUBLISHED', versionNo: 1 });
    await h
      .http()
      .post(`/inspection/templates/versions/${v1}/publish`)
      .set('X-Test-Actor', gm())
      .expect(409);
    // The database itself refuses to touch a published version's content.
    const refusal = (q: Promise<unknown>) =>
      q.then(
        () => 'accepted',
        (e: Error & { cause?: Error }) => (e.cause ?? e).message,
      );
    expect(
      await refusal(
        h.db.execute(
          sql`update inspection.template_items set position = 99 where version_id = ${v1}`,
        ),
      ),
    ).toMatch(/immutable/);
    expect(
      await refusal(
        h.db.execute(
          sql`update inspection.template_item_translations set label = 'x' where entity_id in (select id from inspection.template_items where version_id = ${v1})`,
        ),
      ),
    ).toMatch(/immutable/);
    expect(
      await refusal(
        h.db.execute(sql`update inspection.template_versions set version_no = 9 where id = ${v1}`),
      ),
    ).toMatch(/immutable/);
    const ar = await h
      .http()
      .get(`/inspection/templates/${templateId}`)
      .set('X-Test-Actor', gm())
      .set('accept-language', 'ar')
      .expect(200);
    expect(ar.body.content.sections[0]).toMatchObject({
      title: 'المعدات',
      items: [
        { code: 'EXTINGUISHER', label: 'طفاية الحريق مشحونة ومختومة' },
        {},
        { optionLabels: { MOULD: 'عفن' } },
        {},
        {},
      ],
    });
  });

  it('answers item by item with typed checks and photos of its own', async () => {
    const started = await h
      .http()
      .post(`${base()}/inspections`)
      .set('X-Test-Actor', gm())
      .send({ templateId, locationId: hotel.rooms['504'] })
      .expect(201);
    inspectionId = started.body.id;
    expect(started.body).toMatchObject({ number: 1, status: 'IN_PROGRESS', templateVersionId: v1 });
    const wrongKind = await answer(inspectionId, 'SIGNAGE', {
      kind: 'PASS_FAIL',
      value: 'PASS',
    }).expect(422);
    expect(wrongKind.body.code).toBe('inspection.answer.invalid');
    await answer(inspectionId, 'SURFACES', { kind: 'MULTI_SELECT', value: ['RUST'] }).expect(422);
    await answer(inspectionId, 'NOPE', { kind: 'YES_NO', value: 'YES' }).expect(404);
    // A read-only supervisor cannot answer.
    await answer(
      inspectionId,
      'SIGNAGE',
      { kind: 'YES_NO', value: 'YES' },
      staff(supervisorId, hotel.tenantId),
    ).expect(403);

    await h
      .http()
      .post(`${base()}/inspections/${inspectionId}/photos`)
      .set('X-Test-Actor', gm())
      .set('content-type', 'image/png')
      .send(Buffer.from('<svg/>'))
      .expect(415);
    const photo = await h
      .http()
      .post(`${base()}/inspections/${inspectionId}/photos`)
      .set('X-Test-Actor', gm())
      .set('content-type', 'image/png')
      .send(PNG)
      .expect(201);
    const key: string = photo.body.key;
    expect(key.startsWith(`inspection/${hotel.tenantId}/${inspectionId}/`)).toBe(true);
    await answer(inspectionId, 'PHOTO', {
      kind: 'PHOTO',
      value: [`inspection/${hotel.tenantId}/${newId()}/x.png`],
    }).expect(422);
    await answer(inspectionId, 'PHOTO', { kind: 'PHOTO', value: [key] }).expect(200);
    const served = await h
      .http()
      .get(`${base()}/inspections/${inspectionId}/photos/${key.split('/').at(-1)}`)
      .set('X-Test-Actor', staff(supervisorId, hotel.tenantId))
      .buffer(true)
      .expect(200);
    expect(served.headers['content-type']).toBe('image/png');

    await answer(inspectionId, 'EXTINGUISHER', { kind: 'PASS_FAIL', value: 'PASS' }).expect(200);
    // Changed their mind: the latest answer counts, the first stays as history.
    await answer(inspectionId, 'EXTINGUISHER', { kind: 'PASS_FAIL', value: 'FAIL' }).expect(200);
    await answer(inspectionId, 'SURFACES', {
      kind: 'MULTI_SELECT',
      value: ['DUST', 'MOULD'],
    }).expect(200);
    const incomplete = await h
      .http()
      .post(`${base()}/inspections/${inspectionId}/complete`)
      .set('X-Test-Actor', gm())
      .expect(422);
    expect(incomplete.body.code).toBe('inspection.incomplete');
    await answer(inspectionId, 'SIGNAGE', { kind: 'YES_NO', value: 'NO' }).expect(200);
  });

  it('completes deterministically; a critical finding opens urgent work for the department at once', async () => {
    const done = await h
      .http()
      .post(`${base()}/inspections/${inspectionId}/complete`)
      .set('X-Test-Actor', gm())
      .expect(200);
    expect(done.body).toMatchObject({ status: 'COMPLETED', result: 'FAIL', score: 0 });
    const detail = (
      await h
        .http()
        .get(`${base()}/inspections/${inspectionId}`)
        .set('X-Test-Actor', gm())
        .expect(200)
    ).body as {
      roomNumber: string;
      answers: Array<{ itemCode: string; answer: { value: unknown } }>;
      findings: Array<{
        id: string;
        itemCode: string;
        severity: string;
        status: string;
        workItemId: string | null;
      }>;
    };
    expect(detail.roomNumber).toBe('504');
    expect(detail.answers.find((a) => a.itemCode === 'EXTINGUISHER')?.answer.value).toBe('FAIL');
    expect(
      (
        await h.db.execute(
          sql`select count(*)::int as n from inspection.responses where inspection_id = ${inspectionId}`,
        )
      ).rows[0],
    ).toEqual({ n: 5 });
    const byItem = new Map(detail.findings.map((f) => [f.itemCode, f]));
    expect(byItem.get('EXTINGUISHER')).toMatchObject({ severity: 'CRITICAL', status: 'LINKED' });
    expect(byItem.get('SURFACES')).toMatchObject({
      severity: 'MAJOR',
      status: 'OPEN',
      workItemId: null,
    });
    expect(byItem.get('SIGNAGE')).toMatchObject({ severity: 'MINOR', status: 'OPEN' });
    const work = await h.app
      .get<OperationsPublicApi>(OPERATIONS_API)
      .getWorkItem(hotel.tenantId, byItem.get('EXTINGUISHER')!.workItemId!);
    expect(work).toMatchObject({
      kind: INSPECTION_FINDING_KIND,
      priority: 'URGENT',
      departmentCode: 'ENG',
      locationId: hotel.rooms['504'],
    });
    expect(await outbox('inspection.inspection.completed')).toEqual([
      expect.objectContaining({
        inspection_id: inspectionId,
        template_code: 'FIRE_SAFETY',
        result: 'FAIL',
        findings: { info: 0, minor: 1, major: 1, critical: 1 },
      }),
    ]);
    expect(await outbox('inspection.finding.raised')).toHaveLength(3);
    // Closed: no more answers.
    await answer(inspectionId, 'SIGNAGE', { kind: 'YES_NO', value: 'YES' }).expect(409);

    // A person opens work for the major finding; resolving work resolves the finding.
    const linked = await h
      .http()
      .post(`${base()}/inspection-findings/${byItem.get('SURFACES')!.id}/work`)
      .set('X-Test-Actor', gm())
      .expect(201);
    expect(linked.body).toMatchObject({ status: 'LINKED' });
    await h
      .http()
      .post(`${base()}/inspection-findings/${byItem.get('SURFACES')!.id}/work`)
      .set('X-Test-Actor', gm())
      .expect(409);
    await h.app.get(InspectionService).followWork(
      createEnvelope(WorkItemStatusChanged, {
        eventId: newId(),
        tenantId: hotel.tenantId,
        propertyId: hotel.propertyId,
        source: 'ops',
        correlationId: `insp-${stamp}`,
        occurredAt: new Date(),
        payload: {
          work_item_id: linked.body.workItemId,
          kind: INSPECTION_FINDING_KIND,
          source_entity_type: 'inspection_finding',
          source_entity_id: linked.body.id,
          from: 'IN_PROGRESS',
          to: 'RESOLVED',
        },
      } as never) as EventEnvelope,
    );
    const open = (
      await h.http().get(`${base()}/inspection-findings`).set('X-Test-Actor', gm()).expect(200)
    ).body as Array<{ id: string }>;
    expect(open.map((f) => f.id)).not.toContain(byItem.get('SURFACES')!.id);
    expect(open.map((f) => f.id)).toContain(byItem.get('EXTINGUISHER')!.id);
    const latest = await h.app
      .get<InspectionPublicApi>(INSPECTION_API)
      .latestCompletedAt(hotel.tenantId, hotel.propertyId, hotel.rooms['504']!);
    expect(latest).toMatchObject({ id: inspectionId, result: 'FAIL', score: 0 });
  });

  it('a new version is drafted and published; running inspections keep the version they started on', async () => {
    const running = (
      await h
        .http()
        .post(`${base()}/inspections`)
        .set('X-Test-Actor', gm())
        .send({ templateId, locationId: hotel.rooms['504'] })
        .expect(201)
    ).body as { id: string; templateVersionId: string };
    const draft = await h
      .http()
      .post(`/inspection/templates/${templateId}/versions`)
      .set('X-Test-Actor', gm())
      .send(CHECKLIST)
      .expect(201);
    expect(draft.body).toMatchObject({ versionNo: 2, status: 'DRAFT' });
    // Redrafting replaces the draft, still version 2.
    const redraft = await h
      .http()
      .post(`/inspection/templates/${templateId}/versions`)
      .set('X-Test-Actor', gm())
      .send(CHECKLIST)
      .expect(201);
    expect(redraft.body.versionNo).toBe(2);
    await h
      .http()
      .post(`/inspection/templates/versions/${redraft.body.id}/publish`)
      .set('X-Test-Actor', gm())
      .expect(200);
    const fresh = await h
      .http()
      .post(`${base()}/inspections`)
      .set('X-Test-Actor', gm())
      .send({ templateId, locationId: hotel.rooms['504'] })
      .expect(201);
    expect(fresh.body.templateVersionId).toBe(redraft.body.id);
    expect(
      (
        await h
          .http()
          .get(`${base()}/inspections/${running.id}`)
          .set('X-Test-Actor', gm())
          .expect(200)
      ).body.templateVersionId,
    ).toBe(v1);
    // An inspection on an asset takes the asset's place.
    const asset = newId();
    ASSETS.set(asset, { propertyId: hotel.propertyId, locationId: hotel.rooms['504']! });
    const onAsset = await h
      .http()
      .post(`${base()}/inspections`)
      .set('X-Test-Actor', gm())
      .send({ templateId, assetId: asset })
      .expect(201);
    expect(onAsset.body).toMatchObject({ assetId: asset, locationId: hotel.rooms['504'] });
    await h
      .http()
      .post(`${base()}/inspections/${onAsset.body.id}/cancel`)
      .set('X-Test-Actor', gm())
      .expect(200);
  });

  it('isolates tenants: another tenant’s inspections and templates are not found, and RLS hides them', async () => {
    const foreign = staff(gmId, other.tenantId);
    await h
      .http()
      .get(`/inspection/templates/${templateId}`)
      .set('X-Test-Actor', foreign)
      .expect(404);
    await h
      .http()
      .get(`/properties/${other.propertyId}/inspections/${inspectionId}`)
      .set('X-Test-Actor', foreign)
      .expect(404);
    await h
      .http()
      .post(`/properties/${other.propertyId}/inspections`)
      .set('X-Test-Actor', foreign)
      .send({ templateId, locationId: other.rooms['900'] })
      .expect(404);
    const rows = await h.db.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.tenant_id', ${other.tenantId}, true)`);
      return (
        await tx.execute(
          sql`select count(*)::int as n from inspection.inspections where tenant_id = ${hotel.tenantId}`,
        )
      ).rows;
    });
    expect(rows).toEqual([{ n: 0 }]);
  });
});
