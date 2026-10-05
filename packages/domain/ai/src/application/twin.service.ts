import { Inject, Injectable, Optional } from '@nestjs/common';
import { z } from 'zod';
import type { EventEnvelope } from '@hotella/contracts-events';
import { IDENTITY_API, type IdentityPublicApi } from '@hotella/domain-identity/public';
import { ORGANIZATION_API, type OrganizationPublicApi } from '@hotella/domain-organization/public';
import {
  ActionGate,
  ActorStore,
  PERMISSION_RESOLVER,
  type PermissionResolver,
} from '@hotella/platform-auth';
import { isUuid, type PropertyScope, TransactionRunner } from '@hotella/platform-database';
import { AppError } from '@hotella/platform-i18n';
import { MAX_DEPTH, neighbourhood, TWIN_KINDS, type TwinKind, type TwinRef } from '../domain/twin';
import { TwinRepositories } from '../infrastructure/twin-repositories';
import type { TwinLabeler, TwinLabelRegistrar } from '../public';
import { projectEvent } from './twin-projection';

export const twinQuerySchema = z.object({
  depth: z.coerce.number().int().min(1).max(MAX_DEPTH).default(2),
  /** The twin as it was at this moment (connections only; states are the latest known). */
  at: z.iso.datetime({ offset: true }).optional(),
});

/** Where contexts register names for their kinds (an asset's number and name, a room number). */
@Injectable()
export class TwinLabelRegistry implements TwinLabelRegistrar {
  private readonly labelers = new Map<string, TwinLabeler[]>();
  register(labeler: TwinLabeler): void {
    this.labelers.set(labeler.kind, [...(this.labelers.get(labeler.kind) ?? []), labeler]);
  }
  of(kind: string): readonly TwinLabeler[] {
    return this.labelers.get(kind) ?? [];
  }
}

/** Writes the twin from domain events (the worker's idempotent consumer, inside its transaction). */
@Injectable()
export class TwinProjector {
  constructor(private readonly repo: TwinRepositories) {}

  async project(envelope: EventEnvelope): Promise<void> {
    if (!envelope.tenant_id || !envelope.property_id) return;
    const ops = projectEvent(envelope);
    if (ops.length === 0) return;
    await this.repo.apply(
      { tenantId: envelope.tenant_id, propertyId: envelope.property_id },
      new Date(envelope.occurred_at),
      ops,
    );
  }
}

/** Kinds as they appear in a URL (`room` is the everyday word for a room location). */
function kindOf(path: string): TwinKind | undefined {
  const upper = path.toUpperCase().replace(/-/g, '_');
  if (upper === 'ROOM') return 'LOCATION';
  return (TWIN_KINDS as readonly string[]).includes(upper) ? (upper as TwinKind) : undefined;
}

/**
 * The operational twin (Spec §37, BUILD_PLAN 12.3): `TwinProjector` writes it from events; people with `ai.twin.read` (and
 * the AI_INTELLIGENCE entitlement) read the neighbourhood of a thing, with names looked up at read time through the
 * owning contexts and the reader's own permissions.
 */
@Injectable()
export class TwinService {
  constructor(
    private readonly repo: TwinRepositories,
    private readonly registry: TwinLabelRegistry,
    private readonly gate: ActionGate,
    private readonly actors: ActorStore,
    private readonly tx: TransactionRunner,
    @Inject(PERMISSION_RESOLVER) private readonly permissions: PermissionResolver,
    @Optional() @Inject(ORGANIZATION_API) org?: OrganizationPublicApi,
    @Optional() @Inject(IDENTITY_API) identity?: IdentityPublicApi,
  ) {
    if (org)
      registry.register({
        kind: 'LOCATION',
        labels: async (tenantId, propertyId, ids) => {
          const out = new Map<string, string>();
          for (const id of ids) {
            const room = await org.getRoom(tenantId, propertyId, id);
            const label =
              room?.roomNumber ?? (await org.getLocation(tenantId, propertyId, id))?.code;
            if (label) out.set(id, label);
          }
          return out;
        },
      });
    if (identity)
      registry.register({
        kind: 'STAFF',
        labels: async (tenantId, _propertyId, ids) => {
          const out = new Map<string, string>();
          for (const id of ids) {
            const member = await identity.getStaffMember(tenantId, id);
            if (member) out.set(id, member.displayName);
          }
          return out;
        },
      });
  }

  /** The connected things around one thing, up to `depth` hops (1–3), as they were connected at `at` (default now). */
  read(
    scope: PropertyScope,
    kindPath: string,
    refId: string,
    query: z.infer<typeof twinQuerySchema>,
  ) {
    return this.gate.execute(
      {
        action: 'ai.twin.read',
        tenantId: scope.tenantId,
        propertyId: scope.propertyId,
        entitlement: 'AI_INTELLIGENCE',
      },
      async () => {
        const kind = kindOf(kindPath);
        const at = query.at ? new Date(query.at) : new Date();
        const found = await this.tx.read(async () => {
          if (!kind || !isUuid(refId)) return null;
          const root: TwinRef = { kind, id: refId };
          if (!(await this.repo.node(scope.tenantId, scope.propertyId, root))) return null;
          const graph = await neighbourhood(root, query.depth, (refs) =>
            this.repo.edgesTouching(scope.tenantId, scope.propertyId, refs, at),
          );
          const rows = await this.repo.nodes(scope.tenantId, scope.propertyId, graph.nodes);
          return { root, graph, rows };
        });
        if (!found) throw AppError.notFound('ai.twin.not_found');
        const { root, graph, rows } = found;
        const byRef = new Map(rows.map((r) => [`${r.kind}:${r.refId}`, r]));
        const labels = await this.labels(scope, graph.nodes);
        return {
          root: { kind: root.kind, refId: root.id },
          at: at.toISOString(),
          depth: query.depth,
          truncated: graph.truncated,
          nodes: graph.nodes.map((n) => {
            const row = byRef.get(`${n.kind}:${n.id}`);
            return {
              kind: n.kind,
              refId: n.id,
              distance: n.distance,
              state: row?.state ?? null,
              attributes: (row?.attributes ?? {}) as Record<string, unknown>,
              label: labels.get(`${n.kind}:${n.id}`) ?? null,
            };
          }),
          edges: graph.edges.map((e) => ({
            from: { kind: e.from.kind, refId: e.from.id },
            relation: e.relation,
            to: { kind: e.to.kind, refId: e.to.id },
            validFrom: e.validFrom.toISOString(),
            validTo: e.validTo?.toISOString() ?? null,
          })),
        };
      },
    );
  }

  /** Names from the owning contexts, only for kinds the reader may see (a missing name is simply left out). */
  private async labels(
    scope: PropertyScope,
    refs: readonly TwinRef[],
  ): Promise<Map<string, string>> {
    const actor = this.actors.require();
    const out = new Map<string, string>();
    for (const kind of [...new Set(refs.map((r) => r.kind))]) {
      const ids = refs.filter((r) => r.kind === kind).map((r) => r.id);
      for (const labeler of this.registry.of(kind)) {
        if (
          labeler.permission &&
          (actor.type !== 'USER' ||
            !(await this.permissions.hasPermission(actor, labeler.permission, scope)))
        )
          continue;
        for (const [id, label] of await labeler.labels(scope.tenantId, scope.propertyId, ids))
          if (!out.has(`${kind}:${id}`)) out.set(`${kind}:${id}`, label);
      }
    }
    return out;
  }
}
