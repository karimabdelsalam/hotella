import type { INestApplication } from '@nestjs/common';
import { DocumentBuilder, type OpenAPIObject, SwaggerModule } from '@nestjs/swagger';
import { cleanupOpenApiDoc } from 'nestjs-zod';

export interface OpenApiOptions {
  readonly title: string;
  readonly version: string;
  readonly description?: string;
  /** Mount path, default `api/docs`. */
  readonly path?: string;
  /** Serve the UI (never in production). */
  readonly serve: boolean;
}

/** Builds the OpenAPI document from the zod DTOs (nestjs-zod) and optionally serves Swagger UI. */
export function setupOpenApi(app: INestApplication, options: OpenApiOptions): OpenAPIObject {
  const config = new DocumentBuilder()
    .setTitle(options.title)
    .setVersion(options.version)
    .setDescription(options.description ?? '')
    .addBearerAuth()
    .addGlobalParameters({
      name: 'X-Correlation-Id',
      in: 'header',
      required: false,
      schema: { type: 'string' },
    })
    .build();
  const document = cleanupOpenApiDoc(SwaggerModule.createDocument(app, config));
  if (options.serve)
    SwaggerModule.setup(options.path ?? 'api/docs', app, document, {
      jsonDocumentUrl: `${options.path ?? 'api/docs'}/json`,
    });
  return document;
}
