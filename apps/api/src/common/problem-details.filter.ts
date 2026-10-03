import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { ZodValidationException } from 'nestjs-zod';
import type { ZodError } from 'zod';

/**
 * RFC 9457 Problem Details for every error response (ADR-0012).
 * `code` is a stable machine-readable identifier; `detail` becomes localized in Sprint 0.3.8.
 */
export interface ProblemDetails {
  type: string;
  title: string;
  status: number;
  detail?: string;
  instance: string;
  code: string;
  correlation_id: string | null;
  errors?: ReadonlyArray<{ path: string; message: string }>;
  /** Extension member: per-dependency readiness details from Terminus (/ready). */
  details?: Record<string, unknown>;
}

@Catch()
export class ProblemDetailsFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<Response>();
    const req = ctx.getRequest<Request>();
    const correlationId = (req.headers['x-correlation-id'] as string | undefined) ?? null;

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let code = 'platform.internal_error';
    let title = 'Internal Server Error';
    let detail: string | undefined;
    let errors: ProblemDetails['errors'];
    let details: Record<string, unknown> | undefined;

    if (exception instanceof ZodValidationException) {
      status = HttpStatus.BAD_REQUEST;
      code = 'platform.validation_failed';
      title = 'Validation failed';
      const zodError = exception.getZodError() as ZodError;
      errors = zodError.issues.map((i) => ({
        path: i.path.map(String).join('.'),
        message: i.message,
      }));
    } else if (exception instanceof HttpException) {
      status = exception.getStatus();
      const body = exception.getResponse();
      title = HttpStatus[status]?.toString().replaceAll('_', ' ') ?? 'Error';
      code = `platform.http_${status}`;
      if (typeof body === 'string') {
        detail = body;
      } else {
        const obj = body as { message?: string | string[]; details?: Record<string, unknown> };
        detail = obj.message?.toString();
        if (obj.details && typeof obj.details === 'object') {
          // Terminus HealthCheckResult: keep per-dependency details as an extension member.
          details = obj.details;
          if (status === HttpStatus.SERVICE_UNAVAILABLE) {
            code = 'platform.not_ready';
            title = 'Service not ready';
          }
        }
      }
    }

    const problem: ProblemDetails = {
      type: `https://hotella.app/problems/${code}`,
      title,
      status,
      ...(detail ? { detail } : {}),
      instance: req.originalUrl,
      code,
      correlation_id: correlationId,
      ...(errors ? { errors } : {}),
      ...(details ? { details } : {}),
    };
    res.status(status).type('application/problem+json').send(problem);
  }
}
