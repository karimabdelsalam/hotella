import { sql } from 'drizzle-orm';
import type { EventEnvelope } from '@hotella/contracts-events';
import type { ToolContext } from '@hotella/domain-ai/public';
import { OPERATIONS_API, type OperationsPublicApi } from '@hotella/domain-operations/public';
import { newId } from '@hotella/platform-database';
import { infraSkipReason, needsInfra, readTestInfra } from '@hotella/platform-testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ASSISTANT,
  createHotel,
  type Hotel,
  type LogbookHarness,
  OTHERS,
  staff,
  startLogbookApp,
  TOOLS,
} from './testing/harness';

const stamp = Date.now().toString(36).toUpperCase();

describe.skipIf(needsInfra())(`Logbook (${infraSkipReason()})`, () => {
  const url = readTestInfra().databaseUrl!;
  const gmId = newId();
  const supervisorId = newId();
  const attendantId = newId();
  let h: LogbookHarness;
  let hotel: Hotel;
  let other: Hotel;
  let handoverId: string;
  const gm = () => staff(gmId, hotel.tenantId);
  const supervisor = () => staff(supervisorId, hotel.tenantId);
  const attendant = () => staff(attendantId, hotel.tenantId);
  const base = () => `/properties/${hotel.propertyId}/logbook`;
  const cause = (e: Error & { cause?: Error }) => e.cause?.message ?? e.message;
  const outbox = async (type: string) =>
    (
      (
        await h.db.execute(
          sql`select envelope from platform.outbox where tenant_id = ${hotel.tenantId} and event_type = ${type} order by id`,
        )
      ).rows as Array<{ envelope: EventEnvelope }>
    ).map((r) => r.envelope.payload as Record<string, unknown>);
  const shiftOf = async (department: string, actor = supervisor()) =>
    (
      await h
        .http()
        .get(`${base()}/shift?departmentCode=${department}`)
        .set('X-Test-Actor', actor)
        .expect(200)
    ).body;

  beforeAll(async () => {
    h = await startLogbookApp(url, 'hotella_app_logbook', {
      [gmId]: [
        'org.property.read',
        'org.property.manage',
        'org.location.manage',
        'org.department.manage',
        'logbook.read',
        'logbook.write',
        'logbook.handover.acknowledge',
      ],
      [supervisorId]: ['logbook.read', 'logbook.write', 'logbook.handover.acknowledge'],
      [attendantId]: ['logbook.write'],
    });
    hotel = await createHotel(h, `lb-a-${stamp}`, gmId);
    other = await createHotel(h, `lb-b-${stamp}`, gmId);
    for (const [code, name] of [
      ['HK', 'Housekeeping'],
      ['FO', 'Front office'],
    ])
      await h
        .http()
        .post(`/properties/${hotel.propertyId}/departments`)
        .set('X-Test-Actor', gm())
        .send({ code, translations: [{ locale: 'en', name }] })
        .expect(201);
  });
  afterAll(() => h?.app.close());

  it('records notes and incidents on the running shift; entries are never changed, only corrected', async () => {
    const note = await h
      .http()
      .post(`${base()}/entries`)
      .set('X-Test-Actor', attendant())
      .send({ departmentCode: 'HK', text: 'Linen delivery late, floors 3–4 short of towels' })
      .expect(201);
    const incident = await h
      .http()
      .post(`${base()}/entries`)
      .set('X-Test-Actor', gm())
      .send({
        departmentCode: 'HK',
        kind: 'INCIDENT',
        text: 'Water leak from the bathroom ceiling',
        roomId: hotel.roomId,
      })
      .expect(201);
    await h
      .http()
      .post(`${base()}/entries`)
      .set('X-Test-Actor', gm())
      .send({
        departmentCode: 'HK',
        text: 'Correction: only floor 4 is short of towels',
        correctsEntryId: note.body.id,
      })
      .expect(201);
    await h
      .http()
      .post(`${base()}/entries`)
      .set('X-Test-Actor', gm())
      .send({ departmentCode: 'SPA', text: 'No such department' })
      .expect(404);
    expect(note.body).toMatchObject({
      shift: incident.body.shift,
      shiftDate: incident.body.shiftDate,
    });

    const shift = await shiftOf('HK');
    expect(shift).toMatchObject({ departmentCode: 'HK', shift: note.body.shift, handover: null });
    expect(shift.entries.map((e: { kind: string }) => e.kind)).toEqual([
      'NOTE',
      'INCIDENT',
      'NOTE',
    ]);
    expect(shift.entries[1]).toMatchObject({ roomNumber: '504' });
    expect(shift.facts.entries).toEqual({ total: 3, incidents: 1 });

    const edit = await h.db
      .execute(sql`update logbook.entries set text = 'changed' where id = ${note.body.id}`)
      .then(() => null, cause);
    expect(edit).toMatch(/append-only/);
    // Writing is not reading.
    await h
      .http()
      .get(`${base()}/shift?departmentCode=HK`)
      .set('X-Test-Actor', attendant())
      .expect(403);
  });

  it('drafts the handover from facts counted by code; the assistant only writes the words', async () => {
    const ops = h.app.get<OperationsPublicApi>(OPERATIONS_API);
    ops.registerWorkItemKind({ code: 'LB_TEST', module: 'lb', descriptionKey: 'lb.test' });
    await ops.createWorkItem({
      tenantId: hotel.tenantId,
      propertyId: hotel.propertyId,
      kind: 'LB_TEST',
      source: { module: 'lb', entityType: 'test' },
      title: { text: 'Fix the leak' },
      priority: 'URGENT',
      departmentCode: 'HK',
      locationId: hotel.roomId,
    });
    OTHERS.complaints = [{ severity: 'HIGH' }, { severity: 'LOW' }];
    OTHERS.restrictions = [{ roomId: hotel.roomId, kind: 'OOO', since: new Date().toISOString() }];
    OTHERS.lostfound = { found: 2, lost: 1, proposedMatches: 1, retentionDue: 0 };
    ASSISTANT.answer = 'تسليم الوردية: تسرب مياه في 504، مهمة عاجلة واحدة.';

    const drafted = await h
      .http()
      .post(`${base()}/handovers`)
      .set('X-Test-Actor', gm())
      .set('Accept-Language', 'ar')
      .send({ departmentCode: 'HK' })
      .expect(200);
    handoverId = drafted.body.id;
    expect(ASSISTANT.asks.at(-1)).toMatchObject({
      agentCode: 'SHIFT_HANDOVER',
      locale: 'ar',
      userId: gmId,
    });
    expect(drafted.body).toMatchObject({
      departmentCode: 'HK',
      status: 'DRAFT',
      source: 'AI',
      summary: ASSISTANT.answer,
      draftedById: gmId,
    });
    expect(drafted.body.executionId).toEqual(expect.any(String));
    expect(drafted.body.facts).toMatchObject({
      department: 'HK',
      work: { open: 1, urgent: 1, overdue: 0 },
      complaints: { open: 2, high_or_critical: 1 },
      rooms_out_of_order: [{ room: '504', kind: 'OOO' }],
      lost_found: {
        found_waiting: 2,
        lost_reports_open: 1,
        matches_to_decide: 1,
        past_retention: 0,
      },
      entries: { total: 3, incidents: 1 },
    });

    // The assistant's READ tool returns the same facts and the entries, incidents first.
    const tool = TOOLS.get('logbook.get_shift_facts')!;
    expect(tool).toMatchObject({ risk: 'READ', requiredPermission: 'logbook.read' });
    const ctx: ToolContext = {
      tenantId: hotel.tenantId,
      propertyId: hotel.propertyId,
      executionId: newId(),
      agentCode: 'SHIFT_HANDOVER',
      locale: 'ar',
      guest: null,
      conversationId: null,
    };
    const read = (await tool.handle(
      tool.input.parse({
        department_code: 'HK',
        shift_date: drafted.body.shiftDate,
        shift: drafted.body.shift,
      }),
      ctx,
    )) as { facts: unknown; entries: Array<{ kind: string; room: string | null }> };
    expect(read.facts).toEqual(drafted.body.facts);
    expect(read.entries[0]).toMatchObject({ kind: 'INCIDENT', room: '504' });
  });

  it('the incoming supervisor — not the drafter — acknowledges it; then it never changes', async () => {
    await h
      .http()
      .post(`${base()}/handovers/${handoverId}/acknowledge`)
      .set('X-Test-Actor', gm())
      .send({ version: 1 })
      .expect(409);
    const edited = await h
      .http()
      .put(`${base()}/handovers/${handoverId}`)
      .set('X-Test-Actor', supervisor())
      .send({ version: 1, summary: 'Leak in 504 (room OOO); towels short on floor 4.' })
      .expect(200);
    expect(edited.body).toMatchObject({ edited: true, version: 2 });
    const acknowledged = await h
      .http()
      .post(`${base()}/handovers/${handoverId}/acknowledge`)
      .set('X-Test-Actor', supervisor())
      .send({ version: 2, note: 'Taken over' })
      .expect(200);
    expect(acknowledged.body).toMatchObject({
      status: 'ACKNOWLEDGED',
      acknowledgedById: supervisorId,
    });
    expect(await outbox('logbook.handover.acknowledged')).toEqual([
      expect.objectContaining({ handover_id: handoverId, source: 'AI', edited: true }),
    ]);
    await h
      .http()
      .post(`${base()}/handovers`)
      .set('X-Test-Actor', gm())
      .send({ departmentCode: 'HK' })
      .expect(409);
    await h
      .http()
      .put(`${base()}/handovers/${handoverId}`)
      .set('X-Test-Actor', gm())
      .send({ version: 3, summary: 'rewrite' })
      .expect(409);
    const change = await h.db
      .execute(sql`update logbook.handovers set summary = 'x' where id = ${handoverId}`)
      .then(() => null, cause);
    expect(change).toMatch(/never changes/);
    const shift = await shiftOf('HK');
    expect(shift.handover).toMatchObject({ id: handoverId, status: 'ACKNOWLEDGED' });
  });

  it('without an answer from the assistant the handover is written by hand before it can be acknowledged', async () => {
    ASSISTANT.answer = null;
    const drafted = await h
      .http()
      .post(`${base()}/handovers`)
      .set('X-Test-Actor', gm())
      .send({ departmentCode: 'FO' })
      .expect(200);
    expect(drafted.body).toMatchObject({ source: 'WRITTEN', summary: '' });
    await h
      .http()
      .post(`${base()}/handovers/${drafted.body.id}/acknowledge`)
      .set('X-Test-Actor', supervisor())
      .send({ version: 1 })
      .expect(409);
    const written = await h
      .http()
      .put(`${base()}/handovers/${drafted.body.id}`)
      .set('X-Test-Actor', gm())
      .send({ version: 1, summary: 'Quiet shift. Two late arrivals expected.' })
      .expect(200);
    await h
      .http()
      .post(`${base()}/handovers/${drafted.body.id}/acknowledge`)
      .set('X-Test-Actor', supervisor())
      .send({ version: written.body.version })
      .expect(200);
    const list = await h
      .http()
      .get(`${base()}/handovers`)
      .set('X-Test-Actor', supervisor())
      .expect(200);
    expect(list.body.map((x: { departmentCode: string }) => x.departmentCode).sort()).toEqual([
      'FO',
      'HK',
    ]);
  });

  it('isolates tenants: another tenant’s logbook is not found, and RLS hides it', async () => {
    const foreign = staff(gmId, other.tenantId);
    await h
      .http()
      .post(`/properties/${other.propertyId}/logbook/handovers/${handoverId}/acknowledge`)
      .set('X-Test-Actor', foreign)
      .send({ version: 3 })
      .expect(404);
    const rows = await h.db.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.tenant_id', ${other.tenantId}, true)`);
      return (
        await tx.execute(
          sql`select count(*)::int as n from logbook.entries where tenant_id = ${hotel.tenantId}`,
        )
      ).rows;
    });
    expect(rows).toEqual([{ n: 0 }]);
  });
});
