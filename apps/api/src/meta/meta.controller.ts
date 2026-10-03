import { Body, Controller, Get, Post } from '@nestjs/common';
import { AppError } from '@hotella/platform-i18n';
import { ManifestRegistry, type ModuleManifest } from '@hotella/platform-manifest';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/** Smoke-test DTO proving zod → validation pipe → Problem Details end to end (Sprint 0.1.3). */
export const echoSchema = z.object({
  message: z.string().min(1).max(200),
  locale: z.enum(['en', 'ar']).default('en'),
});
export class EchoDto extends createZodDto(echoSchema) {}

@Controller('meta')
export class MetaController {
  constructor(private readonly manifests: ManifestRegistry) {}

  /** Module manifests (Spec §76): what each bounded context exposes. Read-only; the control plane builds on it. */
  @Get('manifests')
  listManifests(): ModuleManifest[] {
    return this.manifests.all();
  }

  @Get('version')
  version(): { name: string; apiVersion: 'v1' } {
    return { name: 'hotella', apiVersion: 'v1' };
  }

  /** Smoke endpoint for the error pipeline: AppError → localized Problem Details. */
  @Get('fail')
  fail(): never {
    throw AppError.conflict();
  }

  @Post('echo')
  echo(@Body() body: EchoDto): { echoed: string; locale: 'en' | 'ar' } {
    return { echoed: body.message, locale: body.locale };
  }
}
