import { createSign } from 'node:crypto';
import { Inject, Injectable, Optional } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '@hotella/platform-config';
import { SecretResolver } from '@hotella/platform-secrets';

/** One push to one device. Title and body come from the catalog; data carries references only (no guest data). */
export interface PushMessage {
  readonly token: string;
  readonly platform: 'ANDROID' | 'IOS';
  readonly title: string;
  readonly body: string;
  readonly data: Readonly<Record<string, string>>;
}

/** The provider no longer knows the device (uninstalled, token rotated): revoke it, do not retry. */
export class PushTokenGoneError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'PushTokenGoneError';
  }
}
/** A failed send that may succeed later (rate limit, provider outage). Carries a code, never the token. */
export class PushSendError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'PushSendError';
  }
}

/** Delivery channel for staff app pushes (Spec §25 intent ≠ channel, ADR-0023). Swappable for a test double. */
export interface PushChannel {
  /** False when no provider is configured: push deliveries are recorded as skipped. */
  readonly configured: boolean;
  send(message: PushMessage): Promise<{ readonly providerRef: string | null }>;
}
export const PUSH_CHANNEL = Symbol.for('hotella.ops.push-channel');
/** Where FCM and the OAuth token endpoint are (tests point them at a local fake). */
export const FCM_ENDPOINTS = Symbol.for('hotella.ops.fcm-endpoints');
export interface FcmEndpoints {
  readonly fcm: string;
  readonly tokenUri?: string;
}

interface ServiceAccount {
  readonly client_email: string;
  readonly private_key: string;
  readonly token_uri?: string;
}

const SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';
const GOOGLE_TOKEN_URI = 'https://oauth2.googleapis.com/token';
const FCM_BASE = 'https://fcm.googleapis.com';

/**
 * Firebase Cloud Messaging HTTP v1: Android directly, iOS through the APNs key uploaded to the Firebase project. The
 * service-account JSON is a SecretRef (rule 13); an OAuth access token is minted from it (RS256 JWT bearer grant) and
 * reused until shortly before it expires. Only Node's crypto and fetch — no provider SDK.
 */
@Injectable()
export class FcmPushChannel implements PushChannel {
  private account: Promise<ServiceAccount> | undefined;
  private access: { token: string; until: number } | undefined;

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    // Explicit token: see AgentKeys (a nullable type would emit `Object` as metadata).
    @Optional() @Inject(SecretResolver) private readonly secrets?: SecretResolver,
    @Optional() @Inject(FCM_ENDPOINTS) private readonly endpoints: FcmEndpoints = { fcm: FCM_BASE },
  ) {}

  get configured(): boolean {
    return this.config.notifications.push !== null && this.secrets !== undefined;
  }

  async send(message: PushMessage): Promise<{ providerRef: string | null }> {
    const push = this.config.notifications.push;
    if (!push) throw new PushSendError('push_not_configured');
    const token = await this.accessToken();
    const res = await fetch(`${this.endpoints.fcm}/v1/projects/${push.projectId}/messages:send`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        message: {
          token: message.token,
          notification: { title: message.title, body: message.body },
          data: message.data,
          android: { priority: 'HIGH', notification: { sound: 'default' } },
          apns: { headers: { 'apns-priority': '10' }, payload: { aps: { sound: 'default' } } },
        },
      }),
      signal: AbortSignal.timeout(15_000),
    }).catch(() => {
      throw new PushSendError('fcm_unreachable');
    });
    const json = (await res.json().catch(() => ({}))) as {
      name?: string;
      error?: { status?: string; details?: Array<{ errorCode?: string }> };
    };
    if (res.ok) return { providerRef: json.name ?? null };
    const code =
      json.error?.details?.find((d) => d.errorCode)?.errorCode ??
      json.error?.status ??
      `http_${res.status}`;
    // FCM: the token is unknown or no longer valid for this app.
    if (
      res.status === 404 ||
      code === 'UNREGISTERED' ||
      (res.status === 400 && code === 'INVALID_ARGUMENT')
    )
      throw new PushTokenGoneError(code);
    if (res.status === 401) this.access = undefined;
    throw new PushSendError(code);
  }

  private async accessToken(): Promise<string> {
    if (this.access && this.access.until > Date.now()) return this.access.token;
    const account = await (this.account ??= this.loadAccount());
    const uri = this.endpoints.tokenUri ?? account.token_uri ?? GOOGLE_TOKEN_URI;
    const now = Math.floor(Date.now() / 1000);
    const b64 = (v: object) => Buffer.from(JSON.stringify(v)).toString('base64url');
    const unsigned = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({
      iss: account.client_email,
      scope: SCOPE,
      aud: uri,
      iat: now,
      exp: now + 3600,
    })}`;
    const signature = createSign('RSA-SHA256')
      .update(unsigned)
      .sign(account.private_key, 'base64url');
    const res = await fetch(uri, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion: `${unsigned}.${signature}`,
      }),
      signal: AbortSignal.timeout(15_000),
    }).catch(() => {
      throw new PushSendError('oauth_unreachable');
    });
    if (!res.ok) throw new PushSendError(`oauth_http_${res.status}`);
    const json = (await res.json()) as { access_token: string; expires_in?: number };
    this.access = {
      token: json.access_token,
      until: Date.now() + ((json.expires_in ?? 3600) - 120) * 1000,
    };
    return json.access_token;
  }

  private async loadAccount(): Promise<ServiceAccount> {
    const push = this.config.notifications.push;
    if (!push || !this.secrets) throw new PushSendError('push_not_configured');
    try {
      const account = JSON.parse(await this.secrets.resolve(push.credentialsRef)) as ServiceAccount;
      if (!account.client_email || !account.private_key) throw new Error('incomplete');
      return account;
    } catch {
      this.account = undefined;
      throw new PushSendError('fcm_credentials_invalid');
    }
  }
}
