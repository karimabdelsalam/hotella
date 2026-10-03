import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  HttpStatus,
  Injectable,
} from '@nestjs/common';
import { InvalidCursorError } from '@hotella/contracts-api';
import { AppError, CurrentLocale } from '@hotella/platform-i18n';
import { InjectLogger, type Logger } from '@hotella/platform-observability';
import type { Request, Response } from 'express';
import type { ZodError } from 'zod';

/**
 * RFC 9457 Problem Details for every error response (ADR-0012). Unknown exceptions are logged with the
 * correlation id and rendered as a generic 500 so no internals leak.
 * `code` is stable and machine-readable; `detail` is localized from `errors.<code>` in the request locale.
 */
export interface ProblemDetails {
  type: string;
  title: string;
  status: number;
  detail?: string;
  instance: string;
  code: string;
  correlation_id: string | null;
  /** Message parameters (only for client errors that opt in), so UIs can re-render in another locale. */
  params?: Record<string, string | number | boolean | null>;
  errors?: ReadonlyArray<{ path: string; message: string }>;
  /** Extension member: per-dependency readiness details from Terminus (/ready). */
  details?: Record<string, unknown>;
}

const TITLES: Record<string, string> = {
  'platform.validation_failed': 'Validation failed',
  'platform.not_ready': 'Service not ready',
  'platform.internal_error': 'Internal Server Error',
};

@Injectable()
@Catch()
export class ProblemDetailsFilter implements ExceptionFilter {
  constructor(
    private readonly locale: CurrentLocale,
    @InjectLogger() private readonly logger: Logger,
  ) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<Response>();
    const req = ctx.getRequest<Request>();
    const fromResponse = res.getHeader('X-Correlation-Id');
    const correlationId =
      (typeof fromResponse === 'string'
        ? fromResponse
        : (req.headers['x-correlation-id'] as string | undefined)) ?? null;

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let code = 'platform.internal_error';
    let params: Record<string, string | number | boolean | null> = {};
    let exposeParams = false;
    let errors: ProblemDetails['errors'];
    let details: Record<string, unknown> | undefined;

    if (exception instanceof AppError) {
      status = exception.status;
      code = exception.code;
      params = exception.params;
      exposeParams = exception.expose;
    } else if (exception instanceof InvalidCursorError) {
      status = HttpStatus.BAD_REQUEST;
      code = 'platform.invalid_cursor';
    } else if (isZodValidationException(exception)) {
      // Structural check: pnpm may give each package its own nestjs-zod instance, so instanceof is unreliable.
      status = HttpStatus.BAD_REQUEST;
      code = 'platform.validation_failed';
      const zodError = exception.getZodError() as ZodError;
      errors = zodError.issues.map((i) => ({
        path: i.path.map(String).join('.'),
        message: i.message,
      }));
      params = { count: errors.length };
      exposeParams = true;
    } else if (exception instanceof HttpException) {
      status = exception.getStatus();
      code = `platform.http_${status}`;
      const body = exception.getResponse();
      if (typeof body === 'object' && body !== null) {
        const obj = body as { details?: Record<string, unknown> };
        if (obj.details && typeof obj.details === 'object') {
          details = obj.details;
          if (status === HttpStatus.SERVICE_UNAVAILABLE) code = 'platform.not_ready';
        }
      }
    }

    if (status >= 500) {
      this.logger.error(
        {
          err:
            exception instanceof Error
              ? { message: exception.message, stack: exception.stack }
              : exception,
          code,
        },
        'unhandled exception',
      );
    }
    const detailKey = `errors.${code}`;
    const problem: ProblemDetails = {
      type: `https://hotella.app/problems/${code}`,
      title: TITLES[code] ?? HttpStatus[status]?.toString().replaceAll('_', ' ') ?? 'Error',
      status,
      detail: this.locale.t(detailKey, params),
      instance: req.originalUrl,
      code,
      correlation_id: correlationId,
      ...(exposeParams && Object.keys(params).length > 0 ? { params } : {}),
      ...(errors ? { errors } : {}),
      ...(details ? { details } : {}),
    };
    res.status(status).type('application/problem+json').send(problem);
  }
}

function isZodValidationException(value: unknown): value is { getZodError(): unknown } {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { getZodError?: unknown }).getZodError === 'function' &&
    (value as { name?: string }).name === 'ZodValidationException'
  );
}
