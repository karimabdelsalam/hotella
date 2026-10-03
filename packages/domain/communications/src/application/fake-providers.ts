import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  type InboundItem,
  type MessagingProvider,
  ProviderError,
  type SendResult,
  type SmsProvider,
  type TemplateMessage,
  type TextMessage,
} from './providers';

export interface FakeSent {
  readonly channelId: string;
  readonly to: string;
  readonly template?: string;
  readonly parameters?: readonly string[];
  readonly text?: string;
  readonly providerMessageId: string;
}

/**
 * In-memory providers for tests, local development and the pilot smoke (BUILD_PLAN §8.6): they record what was sent
 * and can be told to fail, so fallback and health paths run without a vendor. Webhooks are plain JSON lists of
 * `InboundItem`s with a shared-secret header.
 */
abstract class FakeAdapter {
  readonly sent: FakeSent[] = [];
  failWith: ProviderError | null = null;
  readonly configSchema = z.object({}).catchall(z.unknown());

  protected record(entry: Omit<FakeSent, 'providerMessageId'>): SendResult {
    if (this.failWith) throw this.failWith;
    const providerMessageId = `fake-${randomUUID()}`;
    this.sent.push({ ...entry, providerMessageId });
    return { providerMessageId };
  }
  async verifyWebhook(
    ctx: { credential: () => Promise<string> },
    req: { headers: Readonly<Record<string, string | undefined>> },
  ): Promise<boolean> {
    return req.headers['x-fake-signature'] === (await ctx.credential());
  }
  parseWebhook(_ctx: unknown, body: unknown): readonly InboundItem[] {
    const items = (body as { items?: Array<Record<string, unknown>> }).items ?? [];
    return items.map((i) => ({ ...i, at: new Date(String(i.at)) }) as unknown as InboundItem);
  }
  reset(): void {
    this.sent.length = 0;
    this.failWith = null;
  }
}

export class FakeWhatsAppProvider extends FakeAdapter implements MessagingProvider {
  readonly kind = 'MESSAGING' as const;
  readonly code = 'FAKE_WHATSAPP';
  readonly channelType = 'WHATSAPP' as const;
  async sendTemplate(ctx: { channelId: string }, m: TemplateMessage): Promise<SendResult> {
    return this.record({
      channelId: ctx.channelId,
      to: m.to,
      template: m.template,
      parameters: m.parameters,
    });
  }
  async sendText(ctx: { channelId: string }, m: TextMessage): Promise<SendResult> {
    return this.record({ channelId: ctx.channelId, to: m.to, text: m.body });
  }
}

export class FakeSmsProvider extends FakeAdapter implements SmsProvider {
  readonly kind = 'SMS' as const;
  readonly code = 'FAKE_SMS';
  readonly channelType = 'SMS' as const;
  async sendSms(ctx: { channelId: string }, m: { to: string; text: string }): Promise<SendResult> {
    return this.record({ channelId: ctx.channelId, to: m.to, text: m.text });
  }
}

export { ProviderError };
