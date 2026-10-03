import {
  type CanActivate,
  type ExecutionContext,
  HttpStatus,
  Inject,
  Injectable,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request, Response } from 'express';
import { APP_CONFIG, type AppConfig } from '@hotella/platform-config';
import { AppError } from '@hotella/platform-i18n';
import { InjectLogger, type Logger, RequestContext } from '@hotella/platform-observability';
import { KV_STORE, type KeyValueStore } from './kv-store';

export interface RateLimitPolicy {
  /** Requests allowed per window. */
  readonly limit: number;
  readonly windowSeconds: number;
  /** Bucket by actor when authenticated, else by IP. `ip` forces IP (login, OTP request). */
  readonly keyBy?: 'actor-or-ip' | 'ip';
  /** Policy name; appears in the limit key so different endpoints never share a budget. */
  readonly name: string;
}
export const RATE_LIMIT_KEY = 'hotella:rate-limit';
/** Per-route override of the default policy from config. */
export const RateLimit = (policy: RateLimitPolicy): MethodDecorator & ClassDecorator =>
  SetMetadata(RATE_LIMIT_KEY, policy);
export const SkipRateLimit = (): MethodDecorator & ClassDecorator =>
  SetMetadata(RATE_LIMIT_KEY, { skip: true });

/**
 * Fixed-window limiter on Valkey (ADR-0012). Emits IETF RateLimit headers and `Retry-After`;
 * rejects with 429 `platform.rate_limited` carrying `retryAfterSeconds` for the localized detail.
 */
@Injectable()
export class RateLimitGuard implements CanActivate {
  constructor(
    @Inject(KV_STORE) private readonly store: KeyValueStore,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly ctx: RequestContext,
    private readonly reflector: Reflector,
    @InjectLogger() private readonly logger: Logger,
  ) {}
  private lastWarnAt = 0;

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const meta = this.reflector.getAllAndOverride<
      (RateLimitPolicy & { skip?: boolean }) | undefined
    >(RATE_LIMIT_KEY, [context.getHandler(), context.getClass()]);
    if (meta?.skip) return true;
    const policy: RateLimitPolicy = meta ?? {
      name: 'default',
      limit: this.config.http.rateLimitPerMinute,
      windowSeconds: 60,
      keyBy: 'actor-or-ip',
    };
    const http = context.switchToHttp();
    const req = http.getRequest<Request>();
    const res = http.getResponse<Response>();
    const subject =
      policy.keyBy === 'ip' ? (req.ip ?? 'unknown') : (this.ctx.actor?.id ?? req.ip ?? 'unknown');
    const key = `hotella:rl:${policy.name}:${subject}`;
    let window: { count: number; resetInSeconds: number };
    try {
      window = await this.store.incrementWindow(key, policy.windowSeconds);
    } catch (err) {
      // Fail open: an unavailable limiter store must not take the API down (credential endpoints keep their
      // per-account lockout). Logged at most every 30 s.
      if (Date.now() - this.lastWarnAt > 30_000) {
        this.lastWarnAt = Date.now();
        this.logger.warn(
          { err, policy: policy.name },
          'rate limiter store unavailable; allowing requests',
        );
      }
      return true;
    }
    const { count, resetInSeconds } = window;
    res.setHeader('RateLimit-Limit', String(policy.limit));
    res.setHeader('RateLimit-Remaining', String(Math.max(0, policy.limit - count)));
    res.setHeader('RateLimit-Reset', String(resetInSeconds));
    if (count > policy.limit) {
      res.setHeader('Retry-After', String(resetInSeconds));
      throw new AppError('platform.rate_limited', HttpStatus.TOO_MANY_REQUESTS, {
        retryAfterSeconds: resetInSeconds,
      });
    }
    return true;
  }
}
