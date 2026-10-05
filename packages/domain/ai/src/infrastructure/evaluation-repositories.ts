import { Inject, Injectable } from '@nestjs/common';
import { and, asc, desc, eq, inArray, isNull, or } from 'drizzle-orm';
import { DATABASE, type Database, executor } from '@hotella/platform-database';
import {
  type AgentReleaseRow,
  agentReleases,
  agents,
  type AgentVersionRow,
  agentVersions,
  evaluationCases,
  type EvaluationCaseRow,
  evaluationResults,
  type EvaluationResultRow,
  evaluationRuns,
  type EvaluationRunRow,
  evaluationSets,
  type EvaluationSetRow,
} from './schema';

/** Who sees a row: platform callers (no tenant) see everything; a tenant sees platform rows and its own. */
export type Viewer = { readonly tenantId: string | null };

/** Evaluation sets, cases, runs and results, agent releases and the version moves they make (BUILD_PLAN 12.1). */
@Injectable()
export class EvaluationRepositories {
  constructor(@Inject(DATABASE) private readonly db: Database) {}
  private get x() {
    return executor(this.db);
  }

  private visible(table: typeof evaluationSets | typeof evaluationCases, viewer: Viewer) {
    return viewer.tenantId === null
      ? undefined
      : or(isNull(table.tenantId), eq(table.tenantId, viewer.tenantId));
  }

  // ---- sets and cases ----
  async insertSet(values: typeof evaluationSets.$inferInsert): Promise<EvaluationSetRow> {
    const [row] = await this.x.insert(evaluationSets).values(values).returning();
    return row!;
  }
  async set(viewer: Viewer, id: string): Promise<EvaluationSetRow | undefined> {
    const [row] = await this.x
      .select()
      .from(evaluationSets)
      .where(and(eq(evaluationSets.id, id), this.visible(evaluationSets, viewer)));
    return row;
  }
  sets(viewer: Viewer, agentCode?: string): Promise<EvaluationSetRow[]> {
    return this.x
      .select()
      .from(evaluationSets)
      .where(
        and(
          this.visible(evaluationSets, viewer),
          agentCode ? eq(evaluationSets.agentCode, agentCode) : undefined,
        ),
      )
      .orderBy(asc(evaluationSets.agentCode), asc(evaluationSets.code));
  }
  /** The active platform sets of an agent: what the publish gate requires. */
  activePlatformSets(agentCode: string): Promise<EvaluationSetRow[]> {
    return this.x
      .select()
      .from(evaluationSets)
      .where(
        and(
          isNull(evaluationSets.tenantId),
          eq(evaluationSets.agentCode, agentCode),
          eq(evaluationSets.status, 'ACTIVE'),
        ),
      );
  }
  async updateSet(
    id: string,
    version: number,
    values: Partial<Pick<EvaluationSetRow, 'name' | 'status'>>,
  ): Promise<EvaluationSetRow | undefined> {
    const [row] = await this.x
      .update(evaluationSets)
      .set({ ...values, version: version + 1, updatedAt: new Date() })
      .where(and(eq(evaluationSets.id, id), eq(evaluationSets.version, version)))
      .returning();
    return row;
  }
  async insertCase(values: typeof evaluationCases.$inferInsert): Promise<EvaluationCaseRow> {
    const [row] = await this.x.insert(evaluationCases).values(values).returning();
    return row!;
  }
  cases(setId: string, activeOnly = true): Promise<EvaluationCaseRow[]> {
    return this.x
      .select()
      .from(evaluationCases)
      .where(
        and(
          eq(evaluationCases.setId, setId),
          activeOnly ? eq(evaluationCases.status, 'ACTIVE') : undefined,
        ),
      )
      .orderBy(asc(evaluationCases.code));
  }
  async retireCase(setId: string, id: string): Promise<boolean> {
    const rows = await this.x
      .update(evaluationCases)
      .set({ status: 'RETIRED', updatedAt: new Date() })
      .where(and(eq(evaluationCases.setId, setId), eq(evaluationCases.id, id)))
      .returning({ id: evaluationCases.id });
    return rows.length > 0;
  }

  // ---- runs and results ----
  async insertRun(values: typeof evaluationRuns.$inferInsert): Promise<EvaluationRunRow> {
    const [row] = await this.x.insert(evaluationRuns).values(values).returning();
    return row!;
  }
  async run(viewer: Viewer, id: string): Promise<EvaluationRunRow | undefined> {
    const [row] = await this.x
      .select()
      .from(evaluationRuns)
      .where(
        and(
          eq(evaluationRuns.id, id),
          viewer.tenantId === null ? undefined : eq(evaluationRuns.tenantId, viewer.tenantId),
        ),
      );
    return row;
  }
  async finishRun(
    id: string,
    values: Pick<EvaluationRunRow, 'status' | 'totals' | 'costMinor'>,
  ): Promise<void> {
    await this.x
      .update(evaluationRuns)
      .set({ ...values, finishedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(evaluationRuns.id, id), eq(evaluationRuns.status, 'RUNNING')));
  }
  async insertResult(values: typeof evaluationResults.$inferInsert): Promise<void> {
    await this.x.insert(evaluationResults).values(values);
  }
  results(runId: string): Promise<EvaluationResultRow[]> {
    return this.x
      .select()
      .from(evaluationResults)
      .where(eq(evaluationResults.runId, runId))
      .orderBy(asc(evaluationResults.createdAt));
  }
  /** Runs of a version, newest first (any tenant: the gate looks at the version, not who ran it). */
  runsOfVersion(agentVersionId: string): Promise<EvaluationRunRow[]> {
    return this.x
      .select()
      .from(evaluationRuns)
      .where(eq(evaluationRuns.agentVersionId, agentVersionId))
      .orderBy(desc(evaluationRuns.startedAt));
  }

  // ---- versions and releases ----
  async agentByCode(code: string) {
    const [row] = await this.x.select().from(agents).where(eq(agents.code, code));
    return row;
  }
  async versionById(id: string): Promise<AgentVersionRow | undefined> {
    const [row] = await this.x.select().from(agentVersions).where(eq(agentVersions.id, id));
    return row;
  }
  versionsOf(agentId: string): Promise<AgentVersionRow[]> {
    return this.x
      .select()
      .from(agentVersions)
      .where(eq(agentVersions.agentId, agentId))
      .orderBy(asc(agentVersions.versionNo));
  }
  /** A version arriving with a deployment while another is published: kept as a candidate (DRAFT). */
  async insertCandidate(
    values: Omit<typeof agentVersions.$inferInsert, 'status' | 'publishedAt'>,
  ): Promise<void> {
    await this.x
      .insert(agentVersions)
      .values({ ...values, status: 'DRAFT' })
      .onConflictDoNothing();
  }
  /** The candidate becomes the published version; the previous one is superseded (one transaction). */
  async promote(agentId: string, versionId: string): Promise<AgentVersionRow | undefined> {
    await this.x
      .update(agentVersions)
      .set({ status: 'SUPERSEDED', updatedAt: new Date() })
      .where(and(eq(agentVersions.agentId, agentId), eq(agentVersions.status, 'PUBLISHED')));
    const [row] = await this.x
      .update(agentVersions)
      .set({ status: 'PUBLISHED', publishedAt: new Date(), updatedAt: new Date() })
      .where(
        and(
          eq(agentVersions.agentId, agentId),
          eq(agentVersions.id, versionId),
          eq(agentVersions.status, 'DRAFT'),
        ),
      )
      .returning();
    return row;
  }
  /** Rollback: the current version is superseded and an earlier one runs again (content unchanged, rule 9). */
  async reinstate(agentId: string, versionId: string): Promise<AgentVersionRow | undefined> {
    await this.x
      .update(agentVersions)
      .set({ status: 'SUPERSEDED', updatedAt: new Date() })
      .where(and(eq(agentVersions.agentId, agentId), eq(agentVersions.status, 'PUBLISHED')));
    const [row] = await this.x
      .update(agentVersions)
      .set({ status: 'PUBLISHED', updatedAt: new Date() })
      .where(
        and(
          eq(agentVersions.agentId, agentId),
          eq(agentVersions.id, versionId),
          eq(agentVersions.status, 'SUPERSEDED'),
        ),
      )
      .returning();
    return row;
  }
  /** The open SHADOW run of a version in a tenant (one per tenant, results added as conversations come). */
  async openShadowRun(
    agentVersionId: string,
    tenantId: string,
  ): Promise<EvaluationRunRow | undefined> {
    const [row] = await this.x
      .select()
      .from(evaluationRuns)
      .where(
        and(
          eq(evaluationRuns.agentVersionId, agentVersionId),
          eq(evaluationRuns.tenantId, tenantId),
          eq(evaluationRuns.mode, 'SHADOW'),
          eq(evaluationRuns.status, 'RUNNING'),
        ),
      );
    return row;
  }
  /** Shadow totals are recounted from the results (cheap: one run, its own rows). */
  async refreshShadowTotals(runId: string): Promise<void> {
    const rows = await this.x
      .select({ outcome: evaluationResults.outcome })
      .from(evaluationResults)
      .where(eq(evaluationResults.runId, runId));
    const count = (o: string) => rows.filter((r) => r.outcome === o).length;
    await this.x
      .update(evaluationRuns)
      .set({
        totals: {
          cases: rows.length,
          passed: count('PASS'),
          failed: count('FAIL'),
          errored: count('ERROR'),
        },
        updatedAt: new Date(),
      })
      .where(eq(evaluationRuns.id, runId));
  }
  /** The open SHADOW runs of a version, in every tenant (a trial ends for all of them). */
  openShadowRunsOf(agentVersionId: string): Promise<EvaluationRunRow[]> {
    return this.x
      .select()
      .from(evaluationRuns)
      .where(
        and(
          eq(evaluationRuns.agentVersionId, agentVersionId),
          eq(evaluationRuns.mode, 'SHADOW'),
          eq(evaluationRuns.status, 'RUNNING'),
        ),
      );
  }
  async insertRelease(values: typeof agentReleases.$inferInsert): Promise<AgentReleaseRow> {
    const [row] = await this.x.insert(agentReleases).values(values).returning();
    return row!;
  }
  releases(agentCode: string): Promise<AgentReleaseRow[]> {
    return this.x
      .select()
      .from(agentReleases)
      .where(eq(agentReleases.agentCode, agentCode))
      .orderBy(desc(agentReleases.createdAt));
  }
  casesByIds(ids: readonly string[]): Promise<EvaluationCaseRow[]> {
    return ids.length
      ? this.x
          .select()
          .from(evaluationCases)
          .where(inArray(evaluationCases.id, [...ids]))
      : Promise.resolve([]);
  }
}
