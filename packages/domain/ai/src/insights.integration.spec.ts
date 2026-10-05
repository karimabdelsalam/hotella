import { sql } from 'drizzle-orm';
import {
  ComplaintOpened,
  type EventEnvelope,
  GuestStayRoomChanged,
  SlaBreached,
  StayCreated,
  WorkItemCreated,
  WorkOrderClosed,
} from '@hotella/contracts-events';
import { newId } from '@hotella/platform-database';
import { IdempotentConsumer } from '@hotella/platform-events';
import { RequestContext } from '@hotella/platform-observability';
import { infraSkipReason, needsInfra, readTestInfra } from '@hotella/platform-testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AI_TWIN_CONSUMER } from './ai.module';
import { InsightEngine } from './application/insights.service';
import { SignalRecorder } from './application/signal-recorder';
import { TwinProjector } from './application/twin.service';
import type { DetectedInsight } from './domain/insights';
import { AI_INSIGHT_DETECTORS, type InsightDetectorRegistrar } from './public';
import { type AiHarness, createHotel, type Hotel, staff, startAiApp } from './testing/harness';

const stamp = Date.now().toString(36).toUpperCase();
const DAY = 86_400_000;
const ago = (days: number) => new Date(Date.now() - days * DAY).toISOString();

type Def = { readonly type: string; readonly version: number };
type Insight = {
  id: string;
  detector: string;
  severity: string;
  status: string;
  version: number;
  occurrences: number;
  reasonParams: Record<string, unknown>;
  evidence: Array<{ refIds: string[]; count: number }>;
};

describe.skipIf(needsInfra())(`Insight engine (${infraSkipReason()})`, () => {
  const url = readTestInfra().databaseUrl!;
  const gmId = newId();
  const readerId = newId();
  const otherGmId = newId();
  let h: AiHarness;
  let hotel: Hotel;
  let other: Hotel;
  const asset = newId();
  const workItem = newId();
  /** What the contributed test detector finds (null: nothing); a second one always fails. */
  const contributed: { finding: DetectedInsight | null } = { finding: null };
  const gm = () => staff(gmId, hotel.tenantId);
  const base = () => `/properties/${hotel.propertyId}/insights`;

  /** The worker's twin consumer: twin first, then the insight signals, once per event. */
  const deliver = (def: Def, payload: unknown, at: string) => {
    const envelope: EventEnvelope = {
      event_id: newId(),
      event_type: def.type,
      event_version: def.version,
      tenant_id: hotel.tenantId,
      property_id: hotel.propertyId,
      source: 'test',
      source_reference: null,
      occurred_at: at,
      received_at: at,
      correlation_id: `insights-${stamp}`,
      payload,
    };
    return h.app.get(IdempotentConsumer).once(AI_TWIN_CONSUMER, envelope, async (e) => {
      await h.app.get(TwinProjector).project(e);
      await h.app.get(SignalRecorder).record(e);
    });
  };
  const repair = (daysAgo: number, cause = 'WEAR') =>
    deliver(
      WorkOrderClosed,
      {
        work_order_id: newId(),
        asset_id: asset,
        type: 'CORRECTIVE',
        status: 'DONE',
        symptom_code: 'NOT_COOLING',
        failure_mode_code: 'REFRIGERANT_LEAK',
        cause_code: cause,
        resolution_code: 'RECHARGED',
        downtime_minutes: 60,
      },
      ago(daysAgo),
    );
  const detect = async () =>
    (await h.http().post(`${base()}/detect`).set('X-Test-Actor', gm()).expect(200)).body as {
      raised: number;
      refreshed: number;
      expired: number;
    };
  const list = async (status?: string) =>
    (
      await h
        .http()
        .get(`${base()}${status ? `?status=${status}` : ''}`)
        .set('X-Test-Actor', gm())
        .expect(200)
    ).body as Insight[];
  const of = (items: Insight[], detector: string) => items.find((i) => i.detector === detector)!;

  beforeAll(async () => {
    const base = [
      'org.property.read',
      'org.property.manage',
      'org.location.manage',
      'org.department.manage',
      'catalog.read',
      'catalog.manage',
    ];
    h = await startAiApp(url, 'hotella_app_ai_insights', {
      [gmId]: [...base, 'ai.insight.read', 'ai.insight.act'],
      [readerId]: ['ai.insight.read'],
      [otherGmId]: [...base, 'ai.insight.read', 'ai.insight.act'],
    });
    hotel = await createHotel(h, `ai-ins-${stamp}`, gmId);
    other = await createHotel(h, `ai-ins-b-${stamp}`, otherGmId);
    const registry = h.app.get<InsightDetectorRegistrar>(AI_INSIGHT_DETECTORS);
    registry.register({
      code: `TEST_CONTRIBUTED_${stamp}`,
      detect: async () => (contributed.finding ? [contributed.finding] : []),
    });
    registry.register({
      code: `TEST_BROKEN_${stamp}`,
      detect: async () => {
        throw new Error('broken detector');
      },
    });

    // The Spec §38 example: the same AC unit repaired again and again, mostly for the same cause.
    for (const d of [2, 6, 11, 19]) await repair(d, d === 11 ? 'POWER' : 'WEAR');
    // Engineering missed its targets three times this week (no baseline before).
    await deliver(
      WorkItemCreated,
      {
        work_item_id: workItem,
        kind: 'ENG_WORK_ORDER',
        source_module: 'eng',
        source_entity_type: 'work_order',
        source_entity_id: newId(),
        priority: 'HIGH',
        department_code: 'ENG',
        location_id: hotel.roomId,
        stay_id: null,
        task_ids: [],
      },
      ago(5),
    );
    for (const d of [1, 2, 4])
      await deliver(
        SlaBreached,
        { sla_instance_id: newId(), work_item_id: workItem, target: 'RESOLUTION', due_at: ago(d) },
        ago(d),
      );
    // The stay in room 504 complained twice (the room comes from the twin at that moment).
    await deliver(
      StayCreated,
      { stay_id: hotel.stayId, primary_guest_id: hotel.guestId, status: 'IN_HOUSE' },
      ago(4),
    );
    await deliver(
      GuestStayRoomChanged,
      {
        stay_id: hotel.stayId,
        from_room_id: null,
        to_room_id: hotel.roomId,
        reason: 'INITIAL',
        at: ago(4),
      },
      ago(4),
    );
    for (const d of [3, 1])
      await deliver(
        ComplaintOpened,
        {
          complaint_id: newId(),
          number: d,
          category_code: 'NOISE',
          severity: 'MEDIUM',
          source: 'STAFF',
          stay_id: hotel.stayId,
        },
        ago(d),
      );
  });
  afterAll(() => h?.app.close());

  it('raises one insight per finding, with deterministic evidence and no free text', async () => {
    expect(await detect()).toEqual({ raised: 3, refreshed: 0, expired: 0 });
    const items = await list();
    expect(items.map((i) => i.detector).sort()).toEqual([
      'RECURRING_ASSET_FAILURE',
      'REPEAT_COMPLAINT',
      'SLA_BREACH_CLUSTER',
    ]);
    expect(of(items, 'RECURRING_ASSET_FAILURE')).toMatchObject({
      severity: 'MEDIUM',
      status: 'OPEN',
      occurrences: 1,
      reasonParams: { count: 4, days: 30, cause: 'WEAR' },
    });
    expect(of(items, 'REPEAT_COMPLAINT')).toMatchObject({
      reasonParams: { count: 2, category: 'NOISE' },
    });
    expect(of(items, 'SLA_BREACH_CLUSTER').reasonParams).toMatchObject({
      department: 'ENG',
      count: 3,
    });
    const detail = (
      await h
        .http()
        .get(`${base()}/${of(items, 'RECURRING_ASSET_FAILURE').id}`)
        .set('X-Test-Actor', staff(readerId, hotel.tenantId))
        .expect(200)
    ).body;
    expect(detail.history).toEqual([
      expect.objectContaining({ from: null, to: 'OPEN', actorType: 'SYSTEM' }),
    ]);
    expect(detail.affected).toEqual([{ type: 'ASSET', id: asset }]);
  });

  it('refreshes what it finds again; new evidence counts as another occurrence', async () => {
    expect(await detect()).toEqual({ raised: 0, refreshed: 3, expired: 0 });
    await repair(0.5);
    expect(await detect()).toMatchObject({ raised: 0, refreshed: 3 });
    const failure = of(await list(), 'RECURRING_ASSET_FAILURE');
    expect(failure).toMatchObject({ occurrences: 2, reasonParams: { count: 5 } });
    expect(failure.evidence[0]!.count).toBe(5);
  });

  it('people acknowledge, resolve or dismiss; acting is feedback; a closed insight returns only with new evidence', async () => {
    const failure = of(await list(), 'RECURRING_ASSET_FAILURE');
    const act = (id: string, action: string, body: object, actor = gm()) =>
      h.http().post(`${base()}/${id}/${action}`).set('X-Test-Actor', actor).send(body);
    await act(failure.id, 'acknowledge', { version: failure.version + 5 })
      .expect(409)
      .expect((r) => expect(r.body.code).toBe('ai.insight.version_conflict'));
    await act(
      failure.id,
      'acknowledge',
      { version: failure.version },
      staff(readerId, hotel.tenantId),
    ).expect(403);
    const acked = (await act(failure.id, 'acknowledge', { version: failure.version }).expect(200))
      .body;
    expect(acked.status).toBe('ACKNOWLEDGED');
    const resolved = (
      await act(failure.id, 'resolve', {
        version: acked.version,
        reason: 'Compressor replaced',
      }).expect(200)
    ).body;
    expect(resolved.status).toBe('RESOLVED');
    await act(failure.id, 'dismiss', { version: resolved.version, reason: 'late' })
      .expect(409)
      .expect((r) => expect(r.body.code).toBe('ai.insight.not_movable'));

    const complaint = of(await list(), 'REPEAT_COMPLAINT');
    await act(complaint.id, 'dismiss', { version: complaint.version }).expect(400);
    await act(complaint.id, 'dismiss', {
      version: complaint.version,
      reason: 'Construction next door, known',
    }).expect(200);

    const feedback = await h.db.execute(
      sql`select kind, count(*)::int as n from ai.feedback where tenant_id = ${hotel.tenantId}
            and insight_id is not null group by kind order by kind`,
    );
    expect(feedback.rows).toEqual([
      { kind: 'RECOMMENDATION_ACCEPTED', n: 1 },
      { kind: 'RECOMMENDATION_REJECTED', n: 1 },
    ]);

    // The same evidence does not bring a resolved or dismissed insight back; a new repair does.
    expect(await detect()).toMatchObject({ raised: 0, refreshed: 1 });
    expect((await list()).map((i) => i.detector)).toEqual(['SLA_BREACH_CLUSTER']);
    await repair(0.2);
    expect(await detect()).toMatchObject({ raised: 1 });
    const again = await list();
    expect(again.map((i) => i.detector).sort()).toEqual([
      'RECURRING_ASSET_FAILURE',
      'SLA_BREACH_CLUSTER',
    ]);
    expect(of(again, 'RECURRING_ASSET_FAILURE').id).not.toBe(failure.id);

    const history = (
      await h.http().get(`${base()}/${failure.id}`).set('X-Test-Actor', gm()).expect(200)
    ).body.history.map((x: { to: string }) => x.to);
    expect(history).toEqual(['OPEN', 'ACKNOWLEDGED', 'RESOLVED']);
    await expect(
      h.db.execute(sql`delete from ai.insight_history where insight_id = ${failure.id}`),
    ).rejects.toThrow();
  });

  it('runs contributed detectors (a failing one changes nothing) and expires what is no longer supported', async () => {
    const code = `TEST_CONTRIBUTED_${stamp}`;
    contributed.finding = {
      detector: code,
      fingerprint: 'day:tomorrow',
      severity: 'HIGH',
      confidence: 0.8,
      reasonKey: 'ai.insight.reason.arrival_risk_tomorrow',
      reasonParams: { count: 2 },
      evidence: [
        { kind: 'HIGH_RISK_ARRIVALS', refType: 'STAY', refIds: [newId()], count: 1, window: 'P1D' },
      ],
      affected: [],
      suggestedAction: { key: 'ai.insight.action.prepare_arrivals', params: {} },
    };
    expect(await detect()).toMatchObject({ raised: 1 });
    // HIGH comes first (the AC unit, now at six repairs, is HIGH too).
    const ranked = await list();
    expect(ranked.map((x) => x.severity)).toEqual(['HIGH', 'HIGH', 'MEDIUM']);
    expect(ranked.slice(0, 2).map((x) => x.detector)).toContain(code);
    contributed.finding = null;
    const later = new Date(Date.now() + 2 * DAY);
    const result = await h.app
      .get(RequestContext)
      .run({ tenant_id: hotel.tenantId, property_id: hotel.propertyId }, () =>
        h.app
          .get(InsightEngine)
          .detect({ tenantId: hotel.tenantId, propertyId: hotel.propertyId }, later),
      );
    expect(result.expired).toBeGreaterThanOrEqual(1);
    expect((await list('EXPIRED')).map((i) => i.detector)).toContain(code);

    const events = await h.db.execute(
      sql`select event_type, count(*)::int as n from platform.outbox
           where envelope->>'tenant_id' = ${hotel.tenantId} and event_type like 'ai.insight.%' group by event_type order by event_type`,
    );
    expect(events.rows).toEqual([
      { event_type: 'ai.insight.raised', n: 5 },
      { event_type: 'ai.insight.status_changed', n: expect.any(Number) },
    ]);
  });

  it('belongs to its hotel', async () => {
    const mine = (await list('OPEN,ACKNOWLEDGED,RESOLVED,DISMISSED,EXPIRED'))[0]!;
    await h
      .http()
      .get(`/properties/${other.propertyId}/insights/${mine.id}`)
      .set('X-Test-Actor', staff(otherGmId, other.tenantId))
      .expect(404);
    await h
      .http()
      .get(`${base()}/${mine.id}`)
      .set('X-Test-Actor', staff(otherGmId, other.tenantId))
      .expect(404);
    expect(
      (
        await h
          .http()
          .get(`/properties/${other.propertyId}/insights`)
          .set('X-Test-Actor', staff(otherGmId, other.tenantId))
          .expect(200)
      ).body,
    ).toEqual([]);
    await h.http().get(`${base()}?status=NOPE`).set('X-Test-Actor', gm()).expect(400);
  });
});
