import { Body, Controller, Get, Post } from '@nestjs/common';
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
  @Get('version')
  version(): { name: string; apiVersion: 'v1' } {
    return { name: 'hotella', apiVersion: 'v1' };
  }

  @Post('echo')
  echo(@Body() body: EchoDto): { echoed: string; locale: 'en' | 'ar' } {
    return { echoed: body.message, locale: body.locale };
  }
}
