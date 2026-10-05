import { Inject, Injectable, Optional } from '@nestjs/common';
import { z } from 'zod';
import { AiInsightRaised, AiInsightStatusChanged } from '@hotella/contracts-events';
import { ENTITLEMENT_API, type EntitlementPublicApi } from '@hotella/domain-licensing/public';
import { ORGANIZATION_API, type OrganizationPublicApi } from '@hotella/domain-organization/public';
import { AuditWriter } from '@hotella/platform-audit';
import { ActionGate, ActorStore } from '@hotella/platform-auth';
import { isUuid, newId, type PropertyScope, TransactionRunner } from '@hotella/platform-database';
import { EventPublisher } from '@hotella/platform-events';
import { AppError } from '@hotella/platform-i18n';
import { InjectLogger, type Logger, RequestContext } from '@hotella/platform-observability';
import { SettingsReader } from '@hotella/platform-settings';
import {
  canMove,
  type DetectedInsight,
  INSIGHT_STATUSES,
  type InsightStatus,
  recurringAssetFailure,
  repeatComplaint,
  type Signal,
  slaBreachCluster,
  slowTurnaround,
} from '../domain/insights';
import {
  AI_INSIGHTS_RECURRING_FAILURE,
  AI_INSIGHTS_REPEAT_COMPLAINT,
  AI_INSIGHTS_SLA_CLUSTER,
  AI_INSIGHTS_SLOW_TURNAROUND,
} from '../domain/settings';
import { InsightRepositories } from '../infrastructure/insight-repositories';
import type { InsightRow } from '../infrastructure/schema';
import type { InsightDetector, InsightDetectorRegistrar } from '../public';

const DAY = 86_400_000;
const ENTITLEMENT = 'AI_INTELLIGENCE';
export const BUILT_IN_DETECTORS = [
  'RECURRING_ASSET_FAILURE',
  'SLA_BREACH_CLUSTER',
  'REPEAT_COMPLAINT',
  'SLOW_TURNAROUND',
] as const;

export const insightListSchema = z.object({
  status: z
    .string()
    .optional()
    .transform((v) => (v ? v.split(',') : ['OPEN', 'ACKNOWLEDGED']))
    .pipe(z.array(z.enum(INSIGHT_STATUSES)).min(1).max(5)),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export const insightActSchema = z.object({
  version: z.number().int().min(1),
  reason: z.string().trim().min(1).max(500).optional(),
});
export const insightDismissSchema = insightActSchema.extend({
  reason: z.string().trim().min(1).max(500),
});

/** Detectors other contexts contribute (BUILD_PLAN 12.4), e.g. housekeeping's arrival risk for tomorrow. */
@Injectable()
export class InsightDetectorRegistry implements InsightDetectorRegistrar {
  private readonly detectors = new Map<string, InsightDetector>();
  register(detector: InsightDetector): void {
    if (
      this.detectors.has(detector.code) ||
      (BUILT_IN_DETECTORS as readonly string[]).includes(detector.code)
    )
      throw new Error(`Insight detector ${detector.code} is already registered`);
    this.detectors.set(detector.code, detector);
  }
  all(): readonly InsightDetector[] {
    return [...this.detectors.values()].sort((a, b) => (a.code < b.code ? -1 : 1));
  }
}

/** The longest window an insight's evidence looks at (it expires when its evidence ages out). */
function windowDays(found: DetectedInsight): number {
  return Math.max(1, ...found.evidence.map((e) => Number(/^P(\d+)D$/.exec(e.window)?.[1] ?? 1)));
}
const refIds = (evidence: unknown) =>
  new Set(
    (Array.isArray(evidence) ? (evidence as Array<{ refIds?: unknown }>) : []).flatMap((e) =>
      Array.isArray(e.refIds) ? (e.refIds as string[]) : [],
    ),
  );

/**
 * The insight engine (Spec §38–§39, BUILD_PLAN 12.4): runs the deterministic detectors of a property over its signals
 * (and the registered detectors of other contexts), keeps one live insight per detector and fingerprint, refreshes it
 * when found again, raises a new one only for new evidence after a person closed the last, and expires what is no
 * longer supported. Never calls a model.
 */
@Injectable()
export class InsightEngine {
  constructor(
    private readonly repo: InsightRepositories,
    private readonly registry: InsightDetectorRegistry,
    private readonly tx: TransactionRunner,
    private readonly events: EventPublisher,
    private readonly settings: SettingsReader,
    private readonly ctx: RequestContext,
    @InjectLogger() private readonly logger: Logger,
    @Inject(ORGANIZATION_API) private readonly org: OrganizationPublicApi,
    @Optional() @Inject(ENTITLEMENT_API) private readonly entitlements?: EntitlementPublicApi,
  ) {}

  /** Every active property (the scheduled job); one property's failure does not hold the others back. */
  async sweep(now = new Date()): Promise<number> {
    const properties = await this.tx.read(() => this.repo.activeProperties());
    let raised = 0;
    for (const scope of properties)
      try {
        raised += (
          await this.ctx.run({ tenant_id: scope.tenantId, property_id: scope.propertyId }, () =>
            this.detect(scope, now),
          )
        ).raised;
      } catch (err) {
        this.logger.warn(
          { err, tenant_id: scope.tenantId, property_id: scope.propertyId },
          'insight detection failed',
        );
      }
    return raised;
  }

  /** Runs every detector for one property and applies what they found. */
  async detect(
    scope: PropertyScope,
    now = new Date(),
  ): Promise<{ raised: number; refreshed: number; expired: number }> {
    if (
      this.entitlements &&
      !(await this.entitlements.can(scope.tenantId, scope.propertyId, ENTITLEMENT))
    )
      return { raised: 0, refreshed: 0, expired: 0 };
    const at = { tenantId: scope.tenantId, propertyId: scope.propertyId };
    const recurring = await this.settings.value(AI_INSIGHTS_RECURRING_FAILURE, at);
    const sla = await this.settings.value(AI_INSIGHTS_SLA_CLUSTER, at);
    const complaints = await this.settings.value(AI_INSIGHTS_REPEAT_COMPLAINT, at);
    const turnaround = await this.settings.value(AI_INSIGHTS_SLOW_TURNAROUND, at);
    const lookBack = Math.max(
      recurring.windowDays,
      sla.recentDays + sla.baselineDays,
      complaints.windowDays,
      turnaround.windowDays,
    );
    const signals: Signal[] = (
      await this.tx.read(() =>
        this.repo.signalsSince(scope, new Date(now.getTime() - lookBack * DAY)),
      )
    ).map((s) => ({
      signal: s.signal,
      subjectKind: s.subjectKind,
      subjectRef: s.subjectRef,
      codes: s.codes as Signal['codes'],
      at: s.occurredAt,
    }));
    const needsRoomTypes = signals.some((s) => s.signal === 'HK_JOB_STATUS');
    const roomTypes = new Map<string, string>(
      needsRoomTypes
        ? (await this.org.listRooms(scope.tenantId, scope.propertyId)).flatMap((r) =>
            r.roomTypeId ? [[r.id, r.roomTypeId] as const] : [],
          )
        : [],
    );
    const found: DetectedInsight[] = [
      ...recurringAssetFailure(signals, now, recurring),
      ...slaBreachCluster(signals, now, sla),
      ...repeatComplaint(signals, now, complaints),
      ...slowTurnaround(signals, now, roomTypes, turnaround),
    ];
    const ran: string[] = [...BUILT_IN_DETECTORS];
    for (const detector of this.registry.all())
      try {
        found.push(
          ...(await detector.detect({ ...scope, now })).map((d) => ({
            ...d,
            detector: detector.code,
          })),
        );
        ran.push(detector.code);
      } catch (err) {
        // A failing contributed detector keeps its insights as they are (they are neither refreshed nor expired).
        this.logger.warn({ err, detector: detector.code }, 'insight detector failed');
      }
    return this.tx.run(() => this.apply(scope, now, found, ran));
  }

  private async apply(
    scope: PropertyScope,
    now: Date,
    found: readonly DetectedInsight[],
    ran: readonly string[],
  ): Promise<{ raised: number; refreshed: number; expired: number }> {
    const live = await this.repo.live(scope, ran);
    const key = (detector: string, fingerprint: string) => `${detector}|${fingerprint}`;
    const byKey = new Map(live.map((i) => [key(i.detector, i.fingerprint), i]));
    const seen = new Set<string>();
    let raised = 0;
    let refreshed = 0;
    for (const d of found) {
      const k = key(d.detector, d.fingerprint);
      if (seen.has(k)) continue;
      seen.add(k);
      const expiresAt = new Date(now.getTime() + windowDays(d) * DAY);
      const values = {
        severity: d.severity,
        confidence: d.confidence,
        reasonKey: d.reasonKey,
        reasonParams: d.reasonParams,
        evidence: d.evidence,
        affected: d.affected,
        suggestedAction: d.suggestedAction,
      };
      const current = byKey.get(k);
      if (current) {
        const before = refIds(current.evidence);
        const grew = [...refIds(d.evidence)].some((id) => !before.has(id));
        await this.repo.updateInsight(current.id, current.version, {
          ...values,
          lastSeenAt: now,
          expiresAt,
          occurrences: current.occurrences + (grew ? 1 : 0),
        });
        refreshed++;
        continue;
      }
      // After a person resolved or dismissed it, only new evidence raises it again.
      const closed = await this.repo.lastClosed(scope, d.detector, d.fingerprint);
      if (closed) {
        const known = refIds(closed.evidence);
        if (![...refIds(d.evidence)].some((id) => !known.has(id))) continue;
      }
      const row = await this.repo.insertInsight({
        id: newId(),
        tenantId: scope.tenantId,
        propertyId: scope.propertyId,
        detector: d.detector,
        fingerprint: d.fingerprint,
        ...values,
        status: 'OPEN',
        firstSeenAt: now,
        lastSeenAt: now,
        expiresAt,
      });
      await this.repo.insertHistory({
        id: newId(),
        tenantId: scope.tenantId,
        insightId: row.id,
        fromStatus: null,
        toStatus: 'OPEN',
        actorType: 'SYSTEM',
        at: now,
      });
      await this.events.publish(AiInsightRaised, {
        tenantId: scope.tenantId,
        propertyId: scope.propertyId,
        source: 'ai',
        aggregate: { type: 'ai_insight', id: row.id },
        payload: {
          insight_id: row.id,
          detector: row.detector,
          severity: row.severity,
          confidence: row.confidence,
        },
      });
      raised++;
    }
    // What is no longer found and whose evidence has aged out expires.
    let expired = 0;
    for (const insight of live)
      if (!seen.has(key(insight.detector, insight.fingerprint)) && insight.expiresAt <= now) {
        await moveInsight(
          this.repo,
          this.events,
          insight,
          'EXPIRED',
          { type: 'SYSTEM', id: null },
          now,
        );
        expired++;
      }
    return { raised, refreshed, expired };
  }
}

/** One status move: the row (optimistic), the history row and the event. */
async function moveInsight(
  repo: InsightRepositories,
  events: EventPublisher,
  insight: InsightRow,
  to: InsightStatus,
  actor: { type: string; id: string | null },
  now: Date,
  reason?: string,
): Promise<InsightRow> {
  if (!canMove(insight.status, to)) throw AppError.conflict('ai.insight.not_movable');
  const row = await repo.updateInsight(insight.id, insight.version, { status: to });
  if (!row) throw AppError.conflict('ai.insight.version_conflict');
  await repo.insertHistory({
    id: newId(),
    tenantId: insight.tenantId,
    insightId: insight.id,
    fromStatus: insight.status,
    toStatus: to,
    actorType: actor.type,
    actorId: actor.id,
    reason: reason ?? null,
    at: now,
  });
  await events.publish(AiInsightStatusChanged, {
    tenantId: insight.tenantId,
    propertyId: insight.propertyId,
    source: 'ai',
    aggregate: { type: 'ai_insight', id: insight.id },
    payload: { insight_id: insight.id, detector: insight.detector, from: insight.status, to },
  });
  return row;
}

const view = (i: InsightRow) => ({
  id: i.id,
  detector: i.detector,
  severity: i.severity,
  confidence: i.confidence,
  reasonKey: i.reasonKey,
  reasonParams: i.reasonParams,
  evidence: i.evidence,
  affected: i.affected,
  suggestedAction: i.suggestedAction,
  status: i.status,
  firstSeenAt: i.firstSeenAt,
  lastSeenAt: i.lastSeenAt,
  occurrences: i.occurrences,
  expiresAt: i.expiresAt,
  version: i.version,
});

/**
 * Insights for the people who run the hotel (BUILD_PLAN 12.4): read (`ai.insight.read`), acknowledge, resolve or
 * dismiss with a reason (`ai.insight.act`), and run the detectors now. Acting is feedback on the recommendation
 * (Spec §40) and is audited.
 */
@Injectable()
export class InsightService {
  constructor(
    private readonly repo: InsightRepositories,
    private readonly engine: InsightEngine,
    private readonly gate: ActionGate,
    private readonly actors: ActorStore,
    private readonly tx: TransactionRunner,
    private readonly audit: AuditWriter,
    private readonly events: EventPublisher,
  ) {}

  private request(action: string, scope: PropertyScope) {
    return {
      action,
      tenantId: scope.tenantId,
      propertyId: scope.propertyId,
      entitlement: ENTITLEMENT,
    };
  }

  list(scope: PropertyScope, query: z.infer<typeof insightListSchema>) {
    return this.gate.execute(this.request('ai.insight.read', scope), () =>
      this.tx.read(async () => (await this.repo.list(scope, query.status, query.limit)).map(view)),
    );
  }

  detail(scope: PropertyScope, id: string) {
    return this.gate.execute(this.request('ai.insight.read', scope), () =>
      this.tx.read(async () => {
        const insight = isUuid(id) ? await this.repo.insight(scope, id) : undefined;
        if (!insight) throw AppError.notFound('ai.insight.not_found');
        const history = await this.repo.history(scope, id);
        return {
          ...view(insight),
          history: history.map((h) => ({
            from: h.fromStatus,
            to: h.toStatus,
            actorType: h.actorType,
            actorId: h.actorId,
            reason: h.reason,
            at: h.at,
          })),
        };
      }),
    );
  }

  acknowledge(scope: PropertyScope, id: string, input: z.infer<typeof insightActSchema>) {
    return this.act(scope, id, 'ACKNOWLEDGED', input.version, input.reason);
  }
  resolve(scope: PropertyScope, id: string, input: z.infer<typeof insightActSchema>) {
    return this.act(scope, id, 'RESOLVED', input.version, input.reason);
  }
  dismiss(scope: PropertyScope, id: string, input: z.infer<typeof insightDismissSchema>) {
    return this.act(scope, id, 'DISMISSED', input.version, input.reason);
  }

  /** Runs the detectors of the property now (otherwise they run every hour). */
  detectNow(scope: PropertyScope) {
    return this.gate.execute(this.request('ai.insight.act', scope), () =>
      this.engine.detect(scope),
    );
  }

  private act(
    scope: PropertyScope,
    id: string,
    to: InsightStatus,
    version: number,
    reason: string | undefined,
  ) {
    const actor = this.actors.require();
    return this.gate.execute(this.request('ai.insight.act', scope), () =>
      this.tx.run(async () => {
        const insight = isUuid(id) ? await this.repo.insight(scope, id) : undefined;
        if (!insight) throw AppError.notFound('ai.insight.not_found');
        if (insight.version !== version) throw AppError.conflict('ai.insight.version_conflict');
        const actorId = isUuid(actor.id) ? actor.id : null;
        const row = await moveInsight(
          this.repo,
          this.events,
          insight,
          to,
          { type: actor.type, id: actorId },
          new Date(),
          reason,
        );
        // Taking it up is accepting the recommendation; dismissing it rejects it (Spec §40 implicit feedback).
        await this.repo.recordFeedback({
          id: newId(),
          tenantId: scope.tenantId,
          propertyId: scope.propertyId,
          executionId: null,
          insightId: insight.id,
          kind: to === 'DISMISSED' ? 'RECOMMENDATION_REJECTED' : 'RECOMMENDATION_ACCEPTED',
          details: { detector: insight.detector, status: to },
          actorType: actor.type,
          actorId,
          sourceRef: insight.id,
        });
        await this.audit.record({
          action: `ai.insight.${to === 'ACKNOWLEDGED' ? 'acknowledge' : to === 'RESOLVED' ? 'resolve' : 'dismiss'}`,
          entityType: 'ai_insight',
          entityId: insight.id,
          tenantId: scope.tenantId,
          propertyId: scope.propertyId,
          reason,
          before: { status: insight.status },
          after: { status: to },
        });
        return view(row);
      }),
    );
  }
}
