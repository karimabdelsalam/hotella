import { HttpStatus } from '@nestjs/common';

/**
 * Domain/application error with a stable machine-readable code (ADR-0012). The API layer renders it as
 * RFC 9457 Problem Details and localizes `detail` from `errors.<code>` in the request locale.
 * Codes follow `<domain>.<entity>.<message>` (e.g. `guest.activation.token_expired`).
 */
export class AppError extends Error {
  constructor(
    public readonly code: string,
    public readonly status: number = HttpStatus.BAD_REQUEST,
    public readonly params: Record<string, string | number | boolean | null> = {},
    options?: { cause?: unknown; expose?: boolean },
  ) {
    super(code, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'AppError';
    this.expose = options?.expose ?? status < 500;
  }
  /** Whether params may be returned to clients (never for 5xx by default). */
  readonly expose: boolean;

  static notFound(
    code = 'platform.not_found',
    params?: Record<string, string | number | boolean | null>,
  ): AppError {
    return new AppError(code, HttpStatus.NOT_FOUND, params);
  }
  static forbidden(
    code = 'platform.forbidden',
    params?: Record<string, string | number | boolean | null>,
  ): AppError {
    return new AppError(code, HttpStatus.FORBIDDEN, params);
  }
  static conflict(
    code = 'platform.conflict',
    params?: Record<string, string | number | boolean | null>,
  ): AppError {
    return new AppError(code, HttpStatus.CONFLICT, params);
  }
  static unauthorized(code = 'platform.unauthorized'): AppError {
    return new AppError(code, HttpStatus.UNAUTHORIZED);
  }
}
