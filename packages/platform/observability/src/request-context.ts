import { randomUUID } from 'node:crypto';
import { type DynamicModule, Injectable, Module } from '@nestjs/common';
import { trace } from '@opentelemetry/api';
import { ClsModule, ClsService } from 'nestjs-cls';
import type { Request, Response } from 'express';

export const CORRELATION_HEADER = 'x-correlation-id';
const CORRELATION_RE = /^[A-Za-z0-9._:-]{8,128}$/;

/** Actor types mirror Spec §68 audit actors. */
export type ActorType = 'USER' | 'GUEST' | 'AI_AGENT' | 'SYSTEM' | 'INTEGRATION' | 'SUPPORT';
export interface ActorRef {
  readonly type: ActorType;
  readonly id: string | null;
}

/** The per-request context carried through CLS, jobs and events (Spec §70). */
export interface RequestContextData {
  readonly correlation_id: string;
  readonly tenant_id: string | null;
  readonly property_id: string | null;
  readonly actor_type: ActorType | null;
  readonly actor_id: string | null;
}

export const CLS_KEYS = {
  correlationId: 'correlation_id',
  tenantId: 'tenant_id',
  propertyId: 'property_id',
  actorType: 'actor_type',
  actorId: 'actor_id',
} as const;

@Injectable()
export class RequestContext {
  constructor(private readonly cls: ClsService) {}

  get isActive(): boolean {
    return this.cls.isActive();
  }
  get correlationId(): string | null {
    return this.cls.isActive() ? (this.cls.get<string>(CLS_KEYS.correlationId) ?? null) : null;
  }
  /** Active OpenTelemetry trace id, if the SDK is running and a span is active. */
  get traceId(): string | null {
    const span = trace.getActiveSpan();
    return span ? span.spanContext().traceId : null;
  }
  get tenantId(): string | null {
    return this.cls.isActive() ? (this.cls.get<string>(CLS_KEYS.tenantId) ?? null) : null;
  }
  get propertyId(): string | null {
    return this.cls.isActive() ? (this.cls.get<string>(CLS_KEYS.propertyId) ?? null) : null;
  }
  get actor(): ActorRef | null {
    if (!this.cls.isActive()) return null;
    const type = this.cls.get<ActorType>(CLS_KEYS.actorType);
    return type ? { type, id: this.cls.get<string>(CLS_KEYS.actorId) ?? null } : null;
  }

  /** Set by the auth guard (Phase 1) once the actor and property scope are resolved. */
  setScope(scope: {
    tenantId?: string | null;
    propertyId?: string | null;
    actor?: ActorRef | null;
  }): void {
    if (!this.cls.isActive()) return;
    if (scope.tenantId !== undefined) this.cls.set(CLS_KEYS.tenantId, scope.tenantId);
    if (scope.propertyId !== undefined) this.cls.set(CLS_KEYS.propertyId, scope.propertyId);
    if (scope.actor !== undefined) {
      this.cls.set(CLS_KEYS.actorType, scope.actor?.type ?? null);
      this.cls.set(CLS_KEYS.actorId, scope.actor?.id ?? null);
    }
  }

  /** Snapshot for logs, outbox rows and queue jobs. */
  snapshot(): Partial<RequestContextData> & { trace_id: string | null } {
    return {
      ...(this.correlationId ? { correlation_id: this.correlationId } : {}),
      trace_id: this.traceId,
      tenant_id: this.tenantId,
      property_id: this.propertyId,
      actor_type: this.actor?.type ?? null,
      actor_id: this.actor?.id ?? null,
    };
  }

  /**
   * Runs `fn` inside a fresh context (jobs, event consumers, CLI) restoring a correlation id that
   * travelled with the job/event, or minting one.
   */
  run<T>(seed: Partial<RequestContextData>, fn: () => Promise<T>): Promise<T> {
    return this.cls.run(async () => {
      this.cls.set(CLS_KEYS.correlationId, seed.correlation_id ?? newCorrelationId());
      this.cls.set(CLS_KEYS.tenantId, seed.tenant_id ?? null);
      this.cls.set(CLS_KEYS.propertyId, seed.property_id ?? null);
      this.cls.set(CLS_KEYS.actorType, seed.actor_type ?? null);
      this.cls.set(CLS_KEYS.actorId, seed.actor_id ?? null);
      return fn();
    });
  }
}

export function newCorrelationId(): string {
  return randomUUID();
}

/** Accepts a caller-supplied id only when it is well-formed; otherwise mints one (never trust blindly). */
export function correlationIdFromHeader(value: string | string[] | undefined): string {
  const v = Array.isArray(value) ? value[0] : value;
  return v && CORRELATION_RE.test(v) ? v : newCorrelationId();
}

@Module({})
export class RequestContextModule {
  static forRoot(): DynamicModule {
    return {
      module: RequestContextModule,
      global: true,
      imports: [
        ClsModule.forRoot({
          global: true,
          middleware: {
            mount: true,
            generateId: true,
            idGenerator: (req: Request) => correlationIdFromHeader(req.headers[CORRELATION_HEADER]),
            setup: (cls, req: Request, res: Response) => {
              const id = cls.getId();
              cls.set(CLS_KEYS.correlationId, id);
              res.setHeader('X-Correlation-Id', id);
            },
          },
        }),
      ],
      providers: [RequestContext],
      exports: [RequestContext, ClsModule],
    };
  }
}
