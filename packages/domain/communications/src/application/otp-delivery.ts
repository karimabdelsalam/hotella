import { HttpStatus, Inject, Injectable, Optional } from '@nestjs/common';
import { OPERATIONS_API, type OperationsPublicApi } from '@hotella/domain-operations/public';
import { APP_CONFIG, type AppConfig } from '@hotella/platform-config';
import { newId, type PropertyScope } from '@hotella/platform-database';
import { AppError, I18nService } from '@hotella/platform-i18n';
import { InjectLogger, type Logger } from '@hotella/platform-observability';
import { SecretResolver } from '@hotella/platform-secrets';
import { SettingsReader } from '@hotella/platform-settings';
import {
  type ChannelHealthState,
  deliveryChain,
  deriveOtp,
  healthAfter,
  type OtpChannel,
  type OtpPolicy,
} from '../domain/otp';
import {
  COMMS_OTP_FALLBACK_CHANNELS,
  COMMS_OTP_FALLBACK_TIMEOUT_SECONDS,
  COMMS_OTP_MANUAL_FALLBACK_AFTER_SECONDS,
  COMMS_OTP_PRIMARY_CHANNEL,
} from '../domain/settings';
import { ActivationRepositories } from '../infrastructure/activation-repositories';
import { CommsRepositories } from '../infrastructure/repositories';
import type { ChannelRow, VerificationSessionRow } from '../infrastructure/schema';
import { ChannelRuntime } from './channel.service';
import { ProviderError } from './providers';

/** The OTP key (a SecretRef, ADR-0010); without it no code can be issued or checked. */
@Injectable()
export class OtpKeyring {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Optional() @Inject(SecretResolver) private readonly secrets?: SecretResolver,
  ) {}

  async key(): Promise<string> {
    if (!this.secrets) throw new AppError('comms.otp.unavailable', HttpStatus.SERVICE_UNAVAILABLE);
    try {
      return await this.secrets.resolve(this.config.comms.otpKeyRef);
    } catch {
      throw new AppError('comms.otp.unavailable', HttpStatus.SERVICE_UNAVAILABLE);
    }
  }

  async code(session: Pick<VerificationSessionRow, 'id' | 'otpSeed'>): Promise<string> {
    return deriveOtp(await this.key(), session.id, session.otpSeed);
  }
}

export type DeliveryTrigger = 'INITIAL' | 'AUTO_FALLBACK' | 'MANUAL_FALLBACK';

/**
 * Sends a session's code over the property's channels following the deterministic chain of ADR-0015: a provider
 * error moves on to the next channel at once; every attempt is a `verification_deliveries` row; send outcomes drive
 * channel health, and a channel going OFFLINE/AUTH_FAILED (or skipped because it is) raises one deduplicated alert.
 */
@Injectable()
export class OtpSender {
  constructor(
    private readonly repo: ActivationRepositories,
    private readonly comms: CommsRepositories,
    private readonly runtime: ChannelRuntime,
    private readonly keyring: OtpKeyring,
    private readonly settings: SettingsReader,
    private readonly i18n: I18nService,
    @Inject(OPERATIONS_API) private readonly ops: OperationsPublicApi,
    @InjectLogger() private readonly logger: Logger,
  ) {}

  async policy(tenantId: string, propertyId: string): Promise<OtpPolicy> {
    const at = { tenantId, propertyId };
    const [primary, fallbacks, timeout, manual] = await Promise.all([
      this.settings.value(COMMS_OTP_PRIMARY_CHANNEL, at),
      this.settings.value(COMMS_OTP_FALLBACK_CHANNELS, at),
      this.settings.value(COMMS_OTP_FALLBACK_TIMEOUT_SECONDS, at),
      this.settings.value(COMMS_OTP_MANUAL_FALLBACK_AFTER_SECONDS, at),
    ]);
    return {
      primary,
      fallbacks,
      fallbackTimeoutSeconds: timeout,
      manualFallbackAfterSeconds: manual,
    };
  }

  /** The property's usable OTP channels in chain order (raising the pre-emption alert when one is skipped). */
  async chain(
    scope: PropertyScope,
    policy: OtpPolicy,
  ): Promise<{ chain: readonly OtpChannel[]; channels: Map<OtpChannel, ChannelRow> }> {
    const channels = new Map<OtpChannel, ChannelRow>();
    for (const type of ['WHATSAPP', 'SMS'] as const) {
      const row = (await this.comms.activeChannels(scope, type))[0];
      if (row) channels.set(type, row);
    }
    const health: Partial<Record<OtpChannel, ChannelHealthState>> = {};
    for (const [type, row] of channels) health[type] = row.health;
    const result = deliveryChain(policy, health);
    for (const skipped of result.preempted) await this.alertUnhealthy(channels.get(skipped)!);
    return { chain: result.chain, channels };
  }

  /**
   * Sends on `channel`; on a provider error records the failure and tries the next channels of `remaining`.
   * Returns the channel that accepted the message, or null when every one failed.
   */
  async send(
    session: VerificationSessionRow,
    first: OtpChannel,
    remaining: readonly OtpChannel[],
    channels: Map<OtpChannel, ChannelRow>,
    trigger: DeliveryTrigger,
    propertyName: string,
  ): Promise<OtpChannel | null> {
    const code = await this.keyring.code(session);
    let current: DeliveryTrigger = trigger;
    for (const type of [first, ...remaining.filter((c) => c !== first)]) {
      const channel = channels.get(type);
      if (!channel) continue;
      const now = new Date();
      try {
        const adapter = this.runtime.adapterFor(channel);
        // A voice gateway speaks only into live calls; it cannot deliver a code to a number.
        if (adapter.kind === 'VOICE') throw new ProviderError('REJECTED', false);
        const ctx = this.runtime.context(channel);
        const result =
          adapter.kind === 'MESSAGING'
            ? await adapter.sendTemplate(ctx, {
                to: session.phoneNormalized,
                template: 'otp',
                locale: session.locale,
                parameters: [code],
              })
            : await adapter.sendSms(ctx, {
                to: session.phoneNormalized,
                text: this.i18n.t(
                  'comms.otp.sms_text',
                  { code, property: propertyName },
                  session.locale,
                ),
              });
        await this.repo.insertDelivery({
          id: newId(),
          tenantId: session.tenantId,
          sessionId: session.id,
          channel: type,
          channelId: channel.id,
          providerCode: channel.providerCode,
          trigger: current,
          status: 'SENT',
          providerRef: result.providerMessageId,
          sentAt: now,
          statusAt: now,
        });
        await this.health(channel, 'OK', now);
        return type;
      } catch (e) {
        const code_ =
          e instanceof ProviderError ? e.code : e instanceof AppError ? 'NOT_CONFIGURED' : 'ERROR';
        await this.repo.insertDelivery({
          id: newId(),
          tenantId: session.tenantId,
          sessionId: session.id,
          channel: type,
          channelId: channel.id,
          providerCode: channel.providerCode,
          trigger: current,
          status: 'FAILED',
          errorCode: code_,
          sentAt: now,
          statusAt: now,
        });
        // Never the provider's message: it can echo the phone number.
        this.logger.warn({ channel_id: channel.id, error_code: code_ }, 'OTP delivery failed');
        await this.health(
          channel,
          code_ === 'AUTH_FAILED'
            ? 'AUTH_FAILED'
            : code_ === 'UNAVAILABLE' || code_ === 'TIMEOUT'
              ? 'UNAVAILABLE'
              : 'OTHER_ERROR',
          now,
        );
        current = 'AUTO_FALLBACK';
      }
    }
    return null;
  }

  private async health(
    channel: ChannelRow,
    outcome: 'OK' | 'UNAVAILABLE' | 'AUTH_FAILED' | 'OTHER_ERROR',
    at: Date,
  ): Promise<void> {
    const next = healthAfter(channel.health, outcome);
    if (next === channel.health) return;
    const changed = await this.comms.setHealth(
      { tenantId: channel.tenantId },
      channel.id,
      next,
      at,
    );
    if (changed && (next === 'OFFLINE' || next === 'AUTH_FAILED'))
      await this.alertUnhealthy(changed);
  }

  private async alertUnhealthy(channel: ChannelRow): Promise<void> {
    await this.ops.raiseAlert({
      tenantId: channel.tenantId,
      propertyId: channel.propertyId,
      type: 'CHANNEL_UNHEALTHY',
      severity: 'CRITICAL',
      dedupeKey: `comms.channel.unhealthy:${channel.id}`,
      subject: { type: 'channel', id: channel.id },
      evidence: {
        channel_type: channel.type,
        provider: channel.providerCode,
        health: channel.health,
      },
    });
  }
}
