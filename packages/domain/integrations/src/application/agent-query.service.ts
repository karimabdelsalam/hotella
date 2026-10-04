import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import {
  currentTransaction,
  DATABASE,
  type Database,
  newId,
  type TenantScope,
  withTransaction,
} from '@hotella/platform-database';
import { AppError } from '@hotella/platform-i18n';
import { InjectLogger, type Logger } from '@hotella/platform-observability';
import { LINK_PROTOCOL_QUERIES } from '@hotella/contracts-connectors';
import { ConnectorRegistry } from '../connectors/registry';
import { LinkRepositories } from '../infrastructure/link-repositories';
import { QueryRepositories } from '../infrastructure/query-repositories';
import type { AgentLinkRow } from '../infrastructure/schema';

export const DEFAULT_QUERY_DEADLINE_MS = 15_000;
const MAX_QUERY_DEADLINE_MS = 60_000;
const POLL_MS = 100;

export type AgentQueryOutcome =
  | { readonly status: 'OK'; readonly rows: unknown[]; readonly truncated: boolean }
  /** No connected protocol-2 agent: the caller may try the next connector. */
  | { readonly status: 'UNREACHABLE' }
  | { readonly status: 'TIMEOUT' }
  | { readonly status: 'FAILED'; readonly error: string };

export interface AgentQueryInput {
  readonly tenantId: string;
  readonly propertyId: string;
  readonly instanceId: string;
  readonly connectorCode: string;
  readonly queryType: string;
  readonly params: Record<string, unknown>;
  readonly deadlineMs?: number;
  readonly requestedBy: { readonly type: string; readonly id: string | null };
  readonly correlationId?: string | null;
  readonly routing?: Readonly<Record<string, unknown>> | null;
}

/**
 * Asks a hotel agent a predefined read over link protocol 2 (ADR-0019; guide §4.4) and waits for the answer: the
 * request is recorded (committed, so the gateway that holds the agent's link can see it), the gateway signs and sends
 * it, the agent answers rows the gateway validates against the manifest, and the answer is taken here and cleared.
 * Must run outside a transaction: nothing can be answered before the request is committed.
 */
@Injectable()
export class AgentQueryService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly queries: QueryRepositories,
    private readonly links: LinkRepositories,
    private readonly connectors: ConnectorRegistry,
    @InjectLogger() private readonly logger: Logger,
  ) {}

  /** Is a protocol-2 agent connected for this instance right now? (Joins the ambient unit of work.) */
  async reachable(scope: TenantScope, instanceId: string): Promise<boolean> {
    const link = await this.links.link(scope, instanceId);
    return isReachable(link);
  }

  async run(input: AgentQueryInput): Promise<AgentQueryOutcome> {
    if (currentTransaction())
      throw new Error('AgentQueryService.run must not be called inside a transaction');
    const definition = this.connectors
      .get(input.connectorCode)
      ?.manifest.queries?.find((q) => q.code === input.queryType);
    if (!definition)
      throw new AppError('integration.query.unknown', HttpStatus.UNPROCESSABLE_ENTITY, {
        query: input.queryType,
      });
    const params = definition.params.safeParse(input.params);
    if (!params.success)
      throw new AppError('integration.query.invalid_params', HttpStatus.UNPROCESSABLE_ENTITY, {
        query: input.queryType,
      });
    const scope: TenantScope = { tenantId: input.tenantId };
    const deadlineMs = Math.min(
      input.deadlineMs ?? DEFAULT_QUERY_DEADLINE_MS,
      MAX_QUERY_DEADLINE_MS,
    );
    const deadline = new Date(Date.now() + deadlineMs);
    const id = await withTransaction(
      this.db,
      async () => {
        if (!isReachable(await this.links.link(scope, input.instanceId))) return null;
        const row = await this.queries.insert({
          id: newId(),
          tenantId: input.tenantId,
          propertyId: input.propertyId,
          instanceId: input.instanceId,
          queryType: input.queryType,
          params: params.data as Record<string, unknown>,
          deadlineAt: deadline,
          routing: input.routing ?? null,
          correlationId: input.correlationId ?? null,
          requestedByType: input.requestedBy.type,
          requestedById: input.requestedBy.id,
        });
        return row.id;
      },
      { tenantId: input.tenantId },
    );
    if (!id) return { status: 'UNREACHABLE' };
    while (Date.now() < deadline.getTime() + POLL_MS) {
      const row = await withTransaction(this.db, () => this.queries.takeResult(scope, id), {
        tenantId: input.tenantId,
      });
      switch (row?.status) {
        case 'ANSWERED':
          return {
            status: 'OK',
            rows: (row.result as unknown[] | null) ?? [],
            truncated: row.truncated,
          };
        case 'FAILED':
          return { status: 'FAILED', error: row.error ?? 'failed' };
        case 'EXPIRED':
          return { status: 'TIMEOUT' };
      }
      await new Promise((r) => setTimeout(r, POLL_MS));
    }
    this.logger.warn(
      { query_id: id, query_type: input.queryType, instance_id: input.instanceId },
      'agent query timed out',
    );
    return { status: 'TIMEOUT' };
  }
}

function isReachable(link: AgentLinkRow | undefined): boolean {
  return Boolean(
    link?.sessionId &&
    link.lastConnectedAt &&
    (!link.lastDisconnectedAt || link.lastConnectedAt > link.lastDisconnectedAt) &&
    (link.agentProtocol ?? 1) >= LINK_PROTOCOL_QUERIES,
  );
}
