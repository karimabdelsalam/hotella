import type { INestApplication } from '@nestjs/common';
import { ZodValidationPipe } from 'nestjs-zod';
import { ProblemDetailsFilter } from './common/problem-details.filter';

export const API_PREFIX = 'api/v1';

/** Shared app configuration for main.ts and e2e tests: prefix, validation, error format. */
export function configureApp(app: INestApplication): void {
  app.setGlobalPrefix(API_PREFIX);
  app.useGlobalPipes(new ZodValidationPipe());
  // Resolved from the container so the filter can localize `detail` in the request locale.
  app.useGlobalFilters(app.get(ProblemDetailsFilter));
}
