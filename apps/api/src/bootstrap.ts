import type { INestApplication } from '@nestjs/common';
import { ZodValidationPipe } from 'nestjs-zod';
import type { OpenAPIObject } from '@nestjs/swagger';
import { APP_CONFIG, type AppConfig } from '@hotella/platform-config';
import { setupOpenApi } from '@hotella/platform-http';

export const API_PREFIX = 'api/v1';

/**
 * Shared app configuration for main.ts and e2e tests: prefix, validation, OpenAPI.
 * Problem Details, rate limiting and idempotency are installed globally by HttpConventionsModule.
 */
export function configureApp(
  app: INestApplication,
  options: { openApi?: boolean } = {},
): OpenAPIObject | undefined {
  app.setGlobalPrefix(API_PREFIX);
  app.useGlobalPipes(new ZodValidationPipe());
  const config = app.get<AppConfig>(APP_CONFIG);
  const serve = options.openApi ?? config.http.openApiEnabled;
  return setupOpenApi(app, {
    title: 'Hotella Platform API',
    version: '1.0',
    description: 'Hotel Intelligence Platform — staff, guest and integration APIs.',
    path: 'api/docs',
    serve,
  });
}
