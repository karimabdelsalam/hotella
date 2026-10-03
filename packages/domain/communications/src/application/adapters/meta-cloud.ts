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
import { credentialJson, type FetchLike, sameSecret, validHmacSignature } from './http';

const config = z.object({
  phoneNumberId: z.string().regex(/^\d{5,32}$/),
  apiVersion: z
    .string()
    .regex(/^v\d+\.\d+$/)
    .default('v23.0'),
  graphBaseUrl: z.url().default('https://graph.facebook.com'),
  templates: cloudTemplates,
});

/** Credential JSON (one SecretRef): the system-user access token, the app secret (webhook signatures), the verify token. */
const credential = z.object({
  accessToken: z.string().min(10),
  appSecret: z.string().min(8),
  verifyToken: z.string().min(8),
});

/**
 * WhatsApp through Meta's Cloud API directly (ADR-0015 `WHATSAPP_META_CLOUD`): Graph API `/{phone-number-id}/messages`,
 * webhooks signed with `X-Hub-Signature-256` (HMAC-SHA256 of the raw body with the app secret).
 */
export class MetaCloudWhatsAppAdapter implements MessagingProvider {
  readonly kind = 'MESSAGING' as const;
  readonly code = 'WHATSAPP_META_CLOUD';
  readonly channelType = 'WHATSAPP' as const;
  readonly configSchema = config;

  constructor(private readonly fetchFn: FetchLike = (url, init) => fetch(url, init)) {}

  private async creds(ctx: ProviderContext) {
    const parsed = credential.safeParse(credentialJson(await ctx.credential()));
    if (!parsed.success) throw new ProviderError('AUTH_FAILED', false);
    return parsed.data;
  }

  private url(ctx: ProviderContext): string {
    const c = config.parse(ctx.config);
    return `${c.graphBaseUrl.replace(/\/+$/, '')}/${c.apiVersion}/${c.phoneNumberId}/messages`;
  }

  async sendTemplate(ctx: ProviderContext, m: TemplateMessage): Promise<SendResult> {
    const { accessToken } = await this.creds(ctx);
    return postMessage(
      this.fetchFn,
      this.url(ctx),
      { authorization: `Bearer ${accessToken}` },
      templateBody(m, config.parse(ctx.config).templates),
    );
  }

  async sendText(ctx: ProviderContext, m: TextMessage): Promise<SendResult> {
    const { accessToken } = await this.creds(ctx);
    return postMessage(
      this.fetchFn,
      this.url(ctx),
      { authorization: `Bearer ${accessToken}` },
      textBody(m),
    );
  }

  async verifyWebhook(ctx: ProviderContext, req: WebhookRequest): Promise<boolean> {
    const { appSecret } = await this.creds(ctx);
    return validHmacSignature(appSecret, req.rawBody, req.headers['x-hub-signature-256']);
  }

  /** Meta's subscription handshake (`hub.verify_token`). */
  async verifySubscription(ctx: ProviderContext, token: string | undefined): Promise<boolean> {
    const { verifyToken } = await this.creds(ctx);
    return sameSecret(verifyToken, token);
  }

  parseWebhook(_ctx: ProviderContext, body: unknown) {
    return parseCloudWebhook(body);
  }
}
