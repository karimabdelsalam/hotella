import { z } from 'zod';
import type {
  InboundItem,
  MessageKind,
  ProviderContext,
  SendResult,
  TemplateMessage,
  TextMessage,
} from '../providers';
import { ProviderError } from '../providers';
import { callProvider, type FetchLike, fromWaNumber, statusError, waNumber } from './http';

/**
 * The WhatsApp Cloud API message model (Meta's Graph API; most BSPs relay the same JSON). Shared by the Meta adapter
 * and Cloud-API-compatible BSP adapters: request bodies, error mapping and webhook parsing.
 */

/** A platform template (`otp`, `activation`) mapped to the provider's approved template. */
export const templateConfig = z.object({
  name: z.string().min(1).max(512),
  /** Authentication templates repeat the code in a copy-code URL button. */
  codeButton: z.boolean().default(false),
});
export const cloudTemplates = z.record(z.string().regex(/^[a-z_]+$/), templateConfig).default({});

export function templateBody(m: TemplateMessage, templates: z.infer<typeof cloudTemplates>) {
  const t = templates[m.template];
  if (!t) throw new ProviderError('REJECTED', false);
  const components: unknown[] = [
    { type: 'body', parameters: m.parameters.map((text) => ({ type: 'text', text })) },
  ];
  if (t.codeButton && m.parameters[0])
    components.push({
      type: 'button',
      sub_type: 'url',
      index: '0',
      parameters: [{ type: 'text', text: m.parameters[0] }],
    });
  return {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: waNumber(m.to),
    type: 'template',
    template: { name: t.name, language: { code: languageCode(m.locale) }, components },
  };
}

export function textBody(m: TextMessage) {
  return {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: waNumber(m.to),
    type: 'text',
    text: { body: m.body, preview_url: false },
    ...(m.replyToProviderMessageId ? { context: { message_id: m.replyToProviderMessageId } } : {}),
  };
}

/** Template language codes as WhatsApp names them (`ar`, `en`, `en_US`). */
function languageCode(locale: string): string {
  return locale.replace('-', '_');
}

/** Graph API errors: https://developers.facebook.com/docs/whatsapp/cloud-api/support/error-codes */
export function cloudApiError(status: number, body: unknown): ProviderError {
  const code = (body as { error?: { code?: number } } | null)?.error?.code;
  if (code === 190 || code === 10 || code === 200) return new ProviderError('AUTH_FAILED', false);
  if (code === 4 || code === 80007 || code === 130429 || code === 131048 || code === 131056)
    return new ProviderError('RATE_LIMITED', true);
  if (code === 131026 || code === 131030 || code === 131021)
    return new ProviderError('INVALID_RECIPIENT', false);
  if (code === 131000 || code === 131016) return new ProviderError('UNAVAILABLE', true);
  return statusError(status);
}

export function sentId(body: unknown): SendResult {
  const id = (body as { messages?: Array<{ id?: string }> } | null)?.messages?.[0]?.id;
  if (!id) throw new ProviderError('REJECTED', false);
  return { providerMessageId: id };
}

export async function postMessage(
  fetchFn: FetchLike,
  url: string,
  headers: Record<string, string>,
  body: unknown,
): Promise<SendResult> {
  return sentId(
    await callProvider(
      fetchFn,
      url,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify(body),
      },
      cloudApiError,
    ),
  );
}

const KIND: Record<string, MessageKind> = {
  text: 'TEXT',
  image: 'IMAGE',
  sticker: 'IMAGE',
  audio: 'AUDIO',
  voice: 'AUDIO',
  video: 'VIDEO',
  document: 'DOCUMENT',
  location: 'LOCATION',
  interactive: 'INTERACTIVE',
  button: 'INTERACTIVE',
};

interface CloudMessage {
  id: string;
  from: string;
  timestamp: string;
  type: string;
  text?: { body?: string };
  interactive?: { button_reply?: { title?: string }; list_reply?: { title?: string } };
  button?: { text?: string };
  image?: { id?: string; caption?: string };
  audio?: { id?: string };
  video?: { id?: string; caption?: string };
  document?: { id?: string; caption?: string };
  sticker?: { id?: string };
  voice?: { id?: string };
  location?: { latitude?: number; longitude?: number; name?: string };
  context?: { id?: string };
}
interface CloudStatus {
  id: string;
  status: string;
  timestamp: string;
  errors?: Array<{ code?: number }>;
}

/** Webhook notifications (`entry[].changes[].value.messages|statuses`) → normalized items; unknown parts are skipped. */
export function parseCloudWebhook(body: unknown): InboundItem[] {
  const out: InboundItem[] = [];
  const entries =
    (body as { entry?: Array<{ changes?: Array<{ value?: unknown }> }> } | null)?.entry ?? [];
  for (const entry of entries)
    for (const change of entry.changes ?? []) {
      const value = (change.value ?? {}) as { messages?: CloudMessage[]; statuses?: CloudStatus[] };
      for (const m of value.messages ?? []) {
        if (!m?.id || !m.from) continue;
        const type = KIND[m.type] ?? 'TEXT';
        const media = m.image ?? m.audio ?? m.video ?? m.document ?? m.sticker ?? m.voice;
        const text =
          m.text?.body ??
          m.interactive?.button_reply?.title ??
          m.interactive?.list_reply?.title ??
          m.button?.text ??
          m.image?.caption ??
          m.video?.caption ??
          m.document?.caption ??
          (m.location
            ? `${m.location.name ?? ''} ${m.location.latitude ?? ''},${m.location.longitude ?? ''}`.trim()
            : null);
        out.push({
          kind: 'MESSAGE',
          providerMessageId: m.id,
          from: fromWaNumber(m.from),
          at: new Date(Number(m.timestamp) * 1000),
          type,
          text: text ?? null,
          mediaRef: media?.id ?? null,
          replyToProviderMessageId: m.context?.id ?? null,
        });
      }
      for (const s of value.statuses ?? []) {
        const status =
          s.status === 'sent'
            ? 'SENT'
            : s.status === 'delivered'
              ? 'DELIVERED'
              : s.status === 'read'
                ? 'READ'
                : s.status === 'failed'
                  ? 'FAILED'
                  : null;
        if (!s?.id || !status) continue;
        out.push({
          kind: 'STATUS',
          providerMessageId: s.id,
          status,
          at: new Date(Number(s.timestamp) * 1000),
          errorCode: s.errors?.[0]?.code !== undefined ? String(s.errors[0].code) : null,
        });
      }
    }
  return out;
}

export type { ProviderContext };
