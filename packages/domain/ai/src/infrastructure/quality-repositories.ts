import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, gte, lte, sql } from 'drizzle-orm';
import {
  DATABASE,
  type Database,
  executor,
  newId,
  type PropertyScope,
} from '@hotella/platform-database';
import type { QualityInputs, QualityMetric } from '../domain/quality';
import { type QualityDailyRow, qualityDaily } from './schema';

type Row = Record<string, unknown>;
const num = (v: unknown) => Number(v ?? 0);
const version = (v: unknown) => (typeof v === 'string' ? v : null);

/** Reads what the quality metrics count, and keeps the daily rows (BUILD_PLAN 12.6). */
@Injectable()
export class QualityRepositories {
  constructor(@Inject(DATABASE) private readonly db: Database) {}
  private get x() {
    return executor(this.db);
  }
  private async rows(query: ReturnType<typeof sql>): Promise<Row[]> {
    return (await this.x.execute(query)).rows as Row[];
  }

  /** What happened at a property in [from, to): executions, tool calls, proposals, drafts, replies, requests, insights. */
  async inputs(scope: PropertyScope, from: Date, to: Date): Promise<QualityInputs> {
    const t = scope.tenantId;
    const p = scope.propertyId;
    // Evaluation and shadow runs are not service to anyone; they are left out of quality.
    const live = sql`e.tenant_id = ${t} and e.property_id = ${p} and e.started_at >= ${from} and e.started_at < ${to}
                     and e.trigger not in ('EVALUATION', 'SHADOW')`;
    const executions = await this.rows(sql`
      select e.agent_code, e.agent_version_id, count(*)::int as total,
             count(*) filter (where e.status in ('FAILED', 'HANDED_OFF'))::int as fallback,
             coalesce(sum(e.cost_minor), 0)::int as cost
        from ai.executions e where ${live} group by 1, 2`);
    const toolCalls = await this.rows(sql`
      select e.agent_code, e.agent_version_id, count(*)::int as total,
             count(*) filter (where s.outcome = 'ERROR')::int as failed
        from ai.execution_steps s join ai.executions e on e.id = s.execution_id
       where ${live} and s.type = 'TOOL_CALL' group by 1, 2`);
    const proposals = await this.rows(sql`
      select e.agent_code, e.agent_version_id,
             count(*) filter (where pr.status <> 'PENDING' and pr.status <> 'EXPIRED')::int as decided,
             count(*) filter (where pr.status = 'REJECTED')::int as rejected
        from ai.action_proposals pr join ai.executions e on e.id = pr.execution_id
       where ${live} group by 1, 2`);
    const drafts = await this.rows(sql`
      select e.agent_code, e.agent_version_id, count(*)::int as total,
             coalesce(sum(f.edit_distance), 0)::int as distance
        from ai.feedback f join ai.executions e on e.id = f.execution_id
       where ${live} and f.kind = 'DRAFT_EDIT' group by 1, 2`);
    // A guest who writes again within 24 hours of a completed reply.
    const replies = await this.rows(sql`
      select e.agent_code, e.agent_version_id, count(*)::int as total,
             count(*) filter (where exists (
               select 1 from ai.executions n
                where n.tenant_id = e.tenant_id and n.conversation_id = e.conversation_id
                  and n.trigger = 'MESSAGE' and n.started_at > e.started_at
                  and n.started_at <= e.started_at + interval '24 hours'))::int as recontacted
        from ai.executions e
       where ${live} and e.trigger = 'MESSAGE' and e.conversation_id is not null and e.status = 'COMPLETED'
       group by 1, 2`);
    const [requests] = await this.rows(sql`
      select count(*)::int as total,
             count(*) filter (where exists (
               select 1 from ai.signals c
                where c.tenant_id = s.tenant_id and c.signal = 'SERVICE_REQUEST_STATUS'
                  and c.subject_ref = s.subject_ref and c.codes->>'to' = 'CANCELLED'
                  and c.occurred_at <= s.occurred_at + interval '24 hours'))::int as cancelled
        from ai.signals s
       where s.tenant_id = ${t} and s.property_id = ${p} and s.signal = 'SERVICE_REQUEST_CREATED'
         and s.codes->>'source' = 'AI' and s.occurred_at >= ${from} and s.occurred_at < ${to}`);
    const [recommendations] = await this.rows(sql`
      select count(*) filter (where kind = 'RECOMMENDATION_ACCEPTED')::int as accepted,
             count(*) filter (where kind = 'RECOMMENDATION_REJECTED')::int as rejected
        from ai.feedback
       where tenant_id = ${t} and property_id = ${p} and insight_id is not null
         and created_at >= ${from} and created_at < ${to}`);
    const of = (r: Row) => ({
      agentCode: String(r.agent_code),
      agentVersionId: version(r.agent_version_id),
    });
    return {
      executions: executions.map((r) => ({
        ...of(r),
        total: num(r.total),
        fallback: num(r.fallback),
        costMinor: num(r.cost),
      })),
      toolCalls: toolCalls.map((r) => ({ ...of(r), total: num(r.total), failed: num(r.failed) })),
      proposals: proposals.map((r) => ({
        ...of(r),
        decided: num(r.decided),
        rejected: num(r.rejected),
      })),
      drafts: drafts.map((r) => ({
        ...of(r),
        total: num(r.total),
        editDistanceSum: num(r.distance),
      })),
      replies: replies.map((r) => ({
        ...of(r),
        total: num(r.total),
        recontacted: num(r.recontacted),
      })),
      aiRequests: { total: num(requests?.total), cancelled: num(requests?.cancelled) },
      recommendations: {
        accepted: num(recommendations?.accepted),
        rejected: num(recommendations?.rejected),
      },
    };
  }

  /** Replaces a day's rows of a property (recomputing gives the same result). */
  async replaceDay(
    scope: PropertyScope,
    day: string,
    metrics: readonly QualityMetric[],
  ): Promise<void> {
    await this.x
      .delete(qualityDaily)
      .where(
        and(
          eq(qualityDaily.tenantId, scope.tenantId),
          eq(qualityDaily.propertyId, scope.propertyId),
          eq(qualityDaily.day, day),
        ),
      );
    if (metrics.length)
      await this.x.insert(qualityDaily).values(
        metrics.map((m) => ({
          id: newId(),
          tenantId: scope.tenantId,
          propertyId: scope.propertyId,
          agentCode: m.agentCode,
          agentVersionId: m.agentVersionId,
          day,
          metric: m.metric,
          value: m.value,
          samples: m.samples,
        })),
      );
  }

  list(scope: PropertyScope, from: string, to: string): Promise<QualityDailyRow[]> {
    return this.x
      .select()
      .from(qualityDaily)
      .where(
        and(
          eq(qualityDaily.tenantId, scope.tenantId),
          eq(qualityDaily.propertyId, scope.propertyId),
          gte(qualityDaily.day, from),
          lte(qualityDaily.day, to),
        ),
      )
      .orderBy(
        asc(qualityDaily.day),
        asc(qualityDaily.agentCode),
        sql`${qualityDaily.agentVersionId} asc nulls first`,
        asc(qualityDaily.metric),
      );
  }
}
