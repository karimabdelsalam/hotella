import { Injectable, type OnModuleInit } from '@nestjs/common';
import { PlatformPing } from '@hotella/contracts-events';
import { InjectLogger, type Logger } from '@hotella/platform-observability';
import { EventConsumerRegistry } from '@hotella/platform-queue';

/** Phase 0 acceptance consumer: proves outbox → relay → queue → idempotent consumer end to end. */
@Injectable()
export class PingConsumer implements OnModuleInit {
  readonly received: string[] = [];

  constructor(
    private readonly consumers: EventConsumerRegistry,
    @InjectLogger() private readonly logger: Logger,
  ) {}

  onModuleInit(): void {
    this.consumers.on(PlatformPing.name, 'platform.ping-logger', async (envelope) => {
      const { message } = PlatformPing.parse(envelope).payload;
      this.received.push(message);
      this.logger.info({ event_id: envelope.event_id, message }, 'ping received');
    });
  }
}
