import { z } from 'zod';
import {
  type MessagingProvider,
  type ProviderContext,
  ProviderError,
  type SendResult,
  type TemplateMessage,
  type TextMessage,
  type WebhookRequest,
} from '../providers';
import {
  cloudTemplates,
  parseCloudWebhook,
  postMessage,
  templateBody,
  textBody,
} from './cloud-api';
import { credentialJson, type FetchLike, sameSecret } from './http';

/** Header carrying the shared secret a BSP webhook is configured with (BSPs relay Meta's payload unsigned). */
export const BSP_WEBHOOK_SECRET_HEADER = 'x-hotella-webhook-secret';

const credential = z.object({ apiKey: z.string().min(8), webhookSecret: z.string().min(16) });

/**
 * Base of Business Solution Provider adapters (ADR-0015 `WHATSAPP_BSP_*`) whose API relays the Cloud API message model:
 * a concrete BSP names its endpoint and authentication header. Webhooks carry the Cloud API payload and a shared
 * secret header set when the webhook is registered with the BSP.
 */
export abstract class CloudCompatibleBspAdapter implements MessagingProvider {
  readonly kind = 'MESSAGING' as const;
  readonly channelType = 'WHATSAPP' as const;
  abstract readonly code: string;
  abstract readonly configSchema: z.ZodType<Record<string, unknown>>;
  protected abstract endpoint(config: Record<string, unknown>): string;
  protected abstract authHeaders(apiKey: string): Record<string, string>;
  protected abstract templates(config: Record<string, unknown>): z.infer<typeof cloudTemplates>;

  constructor(private readonly fetchFn: FetchLike = (url, init) => fetch(url, init)) {}

  private async creds(ctx: ProviderContext) {
    const parsed = credential.safeParse(credentialJson(await ctx.credential()));
    if (!parsed.success) throw new ProviderError('AUTH_FAILED', false);
    return parsed.data;
  }

  async sendTemplate(ctx: ProviderContext, m: TemplateMessage): Promise<SendResult> {
    const { apiKey } = await this.creds(ctx);
    return postMessage(
      this.fetchFn,
      this.endpoint(ctx.config),
      this.authHeaders(apiKey),
      templateBody(m, this.templates(ctx.config)),
    );
  }

  async sendText(ctx: ProviderContext, m: TextMessage): Promise<SendResult> {
    const { apiKey } = await this.creds(ctx);
    return postMessage(
      this.fetchFn,
      this.endpoint(ctx.config),
      this.authHeaders(apiKey),
      textBody(m),
    );
  }

  async verifyWebhook(ctx: ProviderContext, req: WebhookRequest): Promise<boolean> {
    const { webhookSecret } = await this.creds(ctx);
    return sameSecret(webhookSecret, req.headers[BSP_WEBHOOK_SECRET_HEADER]);
  }

  parseWebhook(_ctx: ProviderContext, body: unknown) {
    return parseCloudWebhook(body);
  }
}

const dialogConfig = z.object({
  baseUrl: z.url().default('https://waba-v2.360dialog.io'),
  templates: cloudTemplates,
});

/** 360dialog (Cloud API hosted by the BSP): `POST {base}/messages` with the `D360-API-KEY` header. */
export class Dialog360WhatsAppAdapter extends CloudCompatibleBspAdapter {
  readonly code = 'WHATSAPP_BSP_360DIALOG';
  readonly configSchema = dialogConfig;
  protected endpoint(config: Record<string, unknown>): string {
    return `${dialogConfig.parse(config).baseUrl.replace(/\/+$/, '')}/messages`;
  }
  protected authHeaders(apiKey: string): Record<string, string> {
    return { 'D360-API-KEY': apiKey };
  }
  protected templates(config: Record<string, unknown>) {
    return dialogConfig.parse(config).templates;
  }
}
