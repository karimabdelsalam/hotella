import { Injectable, type LoggerService } from '@nestjs/common';
import type { Logger } from 'pino';

/** Adapts pino to NestJS's LoggerService so framework logs share the same JSON stream and redaction. */
@Injectable()
export class PinoNestLogger implements LoggerService {
  constructor(private readonly logger: Logger) {}

  log(message: unknown, context?: string): void {
    this.logger.info({ context }, this.asString(message));
  }
  error(message: unknown, trace?: string, context?: string): void {
    this.logger.error({ context, trace }, this.asString(message));
  }
  warn(message: unknown, context?: string): void {
    this.logger.warn({ context }, this.asString(message));
  }
  debug(message: unknown, context?: string): void {
    this.logger.debug({ context }, this.asString(message));
  }
  verbose(message: unknown, context?: string): void {
    this.logger.trace({ context }, this.asString(message));
  }
  fatal(message: unknown, context?: string): void {
    this.logger.fatal({ context }, this.asString(message));
  }

  private asString(message: unknown): string {
    if (typeof message === 'string') return message;
    if (message instanceof Error) return message.message;
    return JSON.stringify(message);
  }
}
