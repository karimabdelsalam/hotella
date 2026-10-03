import { createHash } from 'node:crypto';
import {
  type CallHandler,
  type ExecutionContext,
  HttpStatus,
  Inject,
  Injectable,
  type NestInterceptor,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { from, type Observable, of, switchMap, tap } from 'rxjs';
import {
  IDEMPOTENCY_KEY_HEADER,
  IDEMPOTENT_REPLAYED_HEADER,
  idempotencyKeySchema,
} from '@hotella/contracts-api';
import { AppError } from '@hotella/platform-i18n';
import { RequestContext } from '@hotella/platform-observability';
import { KV_STORE, type KeyValueStore } from './kv-store';

export const IDEMPOTENCY_TTL_SECONDS = 24 * 3600;
const IN_FLIGHT_TTL_SECONDS = 60;

interface StoredResponse {
  status: number;
  body: unknown;
  bodyHash: string;
}

/**
 * `Idempotency-Key` for retriable creates (ADR-0012). Scope = actor (or tenant, or client IP) + method + path + key.
 * Same key + same body → stored response replayed with `Idempotent-Replayed: true`.
 * Same key + different body → 422 `platform.idempotency_key_reused`.
 * Concurrent duplicate while the first is in flight → 409 `platform.idempotency_in_progress`.
 */
@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  constructor(
    @Inject(KV_STORE) private readonly store: KeyValueStore,
    private readonly ctx: RequestContext,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const http = context.switchToHttp();
    const req = http.getRequest<Request>();
    const res = http.getResponse<Response>();
    const raw = req.headers[IDEMPOTENCY_KEY_HEADER];
    const header = Array.isArray(raw) ? raw[0] : raw;
    if (!header || !['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return next.handle();
    const parsed = idempotencyKeySchema.safeParse(header);
    if (!parsed.success)
      throw new AppError('platform.idempotency_key_invalid', HttpStatus.BAD_REQUEST);

    const actor = this.ctx.actor?.id ?? this.ctx.tenantId ?? req.ip ?? 'anonymous';
    const scopeKey = `hotella:idem:${hash(`${actor}|${req.method}|${req.baseUrl}${req.path}|${parsed.data}`)}`;
    const bodyHash = hash(JSON.stringify(req.body ?? null));

    // The store guards against double execution: when it is unavailable the request is refused (retryable 503)
    // rather than processed without protection.
    const unavailable = () =>
      new AppError('platform.dependency_unavailable', HttpStatus.SERVICE_UNAVAILABLE);
    return from(this.store.get(scopeKey).catch(() => Promise.reject(unavailable()))).pipe(
      switchMap((existing) => {
        if (existing) {
          if (existing === 'IN_FLIGHT')
            throw new AppError('platform.idempotency_in_progress', HttpStatus.CONFLICT);
          const stored = JSON.parse(existing) as StoredResponse;
          if (stored.bodyHash !== bodyHash)
            throw new AppError('platform.idempotency_key_reused', HttpStatus.UNPROCESSABLE_ENTITY);
          res.status(stored.status).setHeader(IDEMPOTENT_REPLAYED_HEADER, 'true');
          return of(stored.body);
        }
        return from(
          this.store
            .setIfAbsent(scopeKey, 'IN_FLIGHT', IN_FLIGHT_TTL_SECONDS)
            .catch(() => Promise.reject(unavailable())),
        ).pipe(
          switchMap((claimed) => {
            if (!claimed)
              throw new AppError('platform.idempotency_in_progress', HttpStatus.CONFLICT);
            return next.handle().pipe(
              tap({
                next: (body) => {
                  const record: StoredResponse = { status: res.statusCode, body, bodyHash };
                  void this.store
                    .set(scopeKey, JSON.stringify(record), IDEMPOTENCY_TTL_SECONDS)
                    .catch(() => undefined); // the in-flight marker expires; a retry then re-executes
                },
                error: () => {
                  void this.store.delete(scopeKey).catch(() => undefined); // a failed attempt may be retried
                },
              }),
            );
          }),
        );
      }),
    );
  }
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('base64url');
}
