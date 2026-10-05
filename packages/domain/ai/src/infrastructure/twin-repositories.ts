import { Inject, Injectable } from '@nestjs/common';
import { and, eq, gt, inArray, isNull, lte, ne, or, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { DATABASE, type Database, executor } from '@hotella/platform-database';
import type { TwinEdge, TwinKind, TwinOp, TwinRef, TwinRelation } from '../domain/twin';
import { twinEdges, type TwinNodeRow, twinNodes } from './schema';

const key = (r: TwinRef) => `${r.kind}:${r.id}`;

/** The operational twin's nodes and edges (BUILD_PLAN 12.3); writes come only from the event projection. */
@Injectable()
export class TwinRepositories {
  constructor(@Inject(DATABASE) private readonly db: Database) {}
  private get x() {
    return executor(this.db);
  }

  /** Applies what one event changes, at the moment it happened (inside the consumer's transaction). */
  async apply(
    scope: { readonly tenantId: string; readonly propertyId: string },
    at: Date,
    ops: readonly TwinOp[],
  ): Promise<void> {
    const ids = new Map<string, string>();
    const node = async (
      ref: TwinRef,
      state?: string,
      attributes?: Readonly<Record<string, unknown>>,
    ): Promise<string> => {
      const known = ids.get(key(ref));
      if (known && state === undefined && attributes === undefined) return known;
      const stateValue = state ?? null;
      const [row] = await this.x
        .insert(twinNodes)
        .values({
          tenantId: scope.tenantId,
          propertyId: scope.propertyId,
          kind: ref.kind,
          refId: ref.id,
          state: stateValue,
          stateAt: state === undefined ? null : at,
          attributes: attributes ?? {},
        })
        .onConflictDoUpdate({
          target: [twinNodes.tenantId, twinNodes.kind, twinNodes.refId],
          // An older event never overwrites a newer state; codes are merged.
          set: {
            state: sql`case when excluded.state is not null and (${twinNodes.stateAt} is null or ${twinNodes.stateAt} <= excluded.state_at) then excluded.state else ${twinNodes.state} end`,
            stateAt: sql`case when excluded.state is not null and (${twinNodes.stateAt} is null or ${twinNodes.stateAt} <= excluded.state_at) then excluded.state_at else ${twinNodes.stateAt} end`,
            attributes: sql`${twinNodes.attributes} || excluded.attributes`,
          },
        })
        .returning({ id: twinNodes.id });
      ids.set(key(ref), row!.id);
      return row!.id;
    };
    const existing = async (ref: TwinRef): Promise<string | undefined> => {
      const known = ids.get(key(ref));
      if (known) return known;
      const [row] = await this.x
        .select({ id: twinNodes.id })
        .from(twinNodes)
        .where(
          and(
            eq(twinNodes.tenantId, scope.tenantId),
            eq(twinNodes.kind, ref.kind),
            eq(twinNodes.refId, ref.id),
          ),
        );
      if (row) ids.set(key(ref), row.id);
      return row?.id;
    };
    const end = (where: ReturnType<typeof and>) =>
      this.x
        .update(twinEdges)
        .set({ validTo: sql`greatest(${twinEdges.validFrom}, ${at.toISOString()}::timestamptz)` })
        .where(and(where, isNull(twinEdges.validTo)));

    for (const op of ops) {
      if (op.op === 'node') await node(op.ref, op.state, op.attributes);
      else if (op.op === 'link') {
        const from = await node(op.from);
        const to = await node(op.to);
        if (op.exclusive)
          await end(
            and(
              eq(twinEdges.fromNode, from),
              eq(twinEdges.relation, op.relation),
              ne(twinEdges.toNode, to),
            ),
          );
        await this.x
          .insert(twinEdges)
          .values({
            tenantId: scope.tenantId,
            propertyId: scope.propertyId,
            fromNode: from,
            relation: op.relation,
            toNode: to,
            validFrom: at,
          })
          .onConflictDoNothing();
      } else {
        const from = await existing(op.from);
        const to = op.to ? await existing(op.to) : undefined;
        if (!from || (op.to && !to)) continue;
        await end(
          and(
            eq(twinEdges.fromNode, from),
            eq(twinEdges.relation, op.relation),
            to ? eq(twinEdges.toNode, to) : undefined,
          ),
        );
      }
    }
  }

  async node(tenantId: string, propertyId: string, ref: TwinRef): Promise<TwinNodeRow | undefined> {
    const [row] = await this.x
      .select()
      .from(twinNodes)
      .where(
        and(
          eq(twinNodes.tenantId, tenantId),
          eq(twinNodes.propertyId, propertyId),
          eq(twinNodes.kind, ref.kind),
          eq(twinNodes.refId, ref.id),
        ),
      );
    return row;
  }

  /** The nodes for refs of one property (state and codes). */
  async nodes(
    tenantId: string,
    propertyId: string,
    refs: readonly TwinRef[],
  ): Promise<TwinNodeRow[]> {
    if (refs.length === 0) return [];
    return this.x
      .select()
      .from(twinNodes)
      .where(
        and(
          eq(twinNodes.tenantId, tenantId),
          eq(twinNodes.propertyId, propertyId),
          inArray(
            twinNodes.refId,
            refs.map((r) => r.id),
          ),
        ),
      );
  }

  /** The edges of a property touching any of the refs, valid at `at`. */
  async edgesTouching(
    tenantId: string,
    propertyId: string,
    refs: readonly TwinRef[],
    at: Date,
  ): Promise<TwinEdge[]> {
    if (refs.length === 0) return [];
    const f = alias(twinNodes, 'f');
    const t = alias(twinNodes, 't');
    const wanted = refs.map((r) => r.id);
    const rows = await this.x
      .select({
        fromKind: f.kind,
        fromId: f.refId,
        relation: twinEdges.relation,
        toKind: t.kind,
        toId: t.refId,
        validFrom: twinEdges.validFrom,
        validTo: twinEdges.validTo,
      })
      .from(twinEdges)
      .innerJoin(f, eq(f.id, twinEdges.fromNode))
      .innerJoin(t, eq(t.id, twinEdges.toNode))
      .where(
        and(
          eq(twinEdges.tenantId, tenantId),
          eq(twinEdges.propertyId, propertyId),
          or(inArray(f.refId, wanted), inArray(t.refId, wanted)),
          lte(twinEdges.validFrom, at),
          or(isNull(twinEdges.validTo), gt(twinEdges.validTo, at)),
        ),
      );
    const asked = new Set(refs.map(key));
    return rows
      .map((r) => ({
        from: { kind: r.fromKind as TwinKind, id: r.fromId },
        relation: r.relation as TwinRelation,
        to: { kind: r.toKind as TwinKind, id: r.toId },
        validFrom: r.validFrom,
        validTo: r.validTo,
      }))
      .filter((e) => asked.has(key(e.from)) || asked.has(key(e.to)));
  }
}
