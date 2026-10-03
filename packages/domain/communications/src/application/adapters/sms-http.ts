import { z } from 'zod';
import {
  type InboundItem,
  type ProviderContext,
  ProviderError,
  type SendResult,
  type SmsProvider,
  type WebhookRequest,
} from '../providers';
import { BSP_WEBHOOK_SECRET_HEADER } from './bsp';
import { callProvider, credentialJson, type FetchLike, sameSecret, statusError } from './http';

const config = z.object({
  url: z.url(),
  senderId: z.string().min(1).max(16),
  /** Dotted path of the message id in the aggregator's JSON answer. */
  idPath: z
    .string()
    .regex(/^[A-Za-z0-9_.]+$/)
    .default('id'),
});
const credential = z.object({ apiKey: z.string().min(8), webhookSecret: z.string().min(16) });

/**
 * A generic JSON-over-HTTP SMS aggregator (ADR-0015 `SmsProvider`; the concrete aggregator is chosen at pilot, Egyptian
 * aggregators expected): `POST url {to, from, text}` with a bearer key; delivery receipts `{id, status, at}` posted back
 * with the shared secret header.
 */
export class JsonHttpSmsAdapter implements SmsProvider {
  readonly kind = 'SMS' as const;
  readonly code = 'SMS_HTTP_JSON';
  readonly channelType = 'SMS' as const;
  readonly configSchema = config;

  constructor(private readonly fetchFn: FetchLike = (url, init) => fetch(url, init)) {}

  private async creds(ctx: ProviderContext) {
    const parsed = credential.safeParse(credentialJson(await ctx.credential()));
    if (!parsed.success) throw new ProviderError('AUTH_FAILED', false);
    return parsed.data;
  }

  async sendSms(ctx: ProviderContext, m: { to: string; text: string }): Promise<SendResult> {
    const c = config.parse(ctx.config);
    const { apiKey } = await this.creds(ctx);
    const body = await callProvider(
      this.fetchFn,
      c.url,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ to: m.to, from: c.senderId, text: m.text }),
      },
      (status) => statusError(status),
    );
    const id = c.idPath
      .split('.')
      .reduce<unknown>((o, k) => (o as Record<string, unknown> | null)?.[k], body);
    if (typeof id !== 'string' && typeof id !== 'number')
      throw new ProviderError('REJECTED', false);
    return { providerMessageId: String(id) };
  }

  async verifyWebhook(ctx: ProviderContext, req: WebhookRequest): Promise<boolean> {
    const { webhookSecret } = await this.creds(ctx);
    return sameSecret(webhookSecret, req.headers[BSP_WEBHOOK_SECRET_HEADER]);
  }

  parseWebhook(_ctx: ProviderContext, body: unknown): InboundItem[] {
    const list = Array.isArray(body) ? body : [body];
    const out: InboundItem[] = [];
    for (const r of list as Array<{
      id?: unknown;
      status?: unknown;
      at?: unknown;
      error?: unknown;
    }>) {
      const status = String(r?.status ?? '').toUpperCase();
      if (r?.id === undefined || !['SENT', 'DELIVERED', 'FAILED'].includes(status)) continue;
      out.push({
        kind: 'STATUS',
        providerMessageId: String(r.id),
        status: status as 'SENT' | 'DELIVERED' | 'FAILED',
        at: r.at ? new Date(String(r.at)) : new Date(),
        errorCode: r.error !== undefined ? String(r.error).slice(0, 32) : null,
      });
    }
    return out;
  }
}
