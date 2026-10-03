import { Inject, Injectable } from '@nestjs/common';
import { z } from 'zod';
import { NotificationRequested } from '@hotella/contracts-events';
import { IDENTITY_API, type IdentityPublicApi } from '@hotella/domain-identity/public';
import { ActionGate, ActorStore } from '@hotella/platform-auth';
import {
  isUuid,
  newId,
  type PropertyScope,
  type TenantScope,
  TransactionRunner,
} from '@hotella/platform-database';
import { EventPublisher } from '@hotella/platform-events';
import { AppError, CurrentLocale, I18nService } from '@hotella/platform-i18n';
import { InjectLogger, type Logger } from '@hotella/platform-observability';
import {
  channelsFor,
  MAX_DELIVERY_ATTEMPTS,
  type NotificationChannel,
  type NotificationPriority,
  retryDelayMs,
} from '../domain/notification';
import { NotificationRepositories } from '../infrastructure/notification-repositories';
import {
  notificationDeliveries,
  type NotificationDeliveryRow,
  type NotificationIntentRow,
} from '../infrastructure/schema';

type NewDelivery = typeof notificationDeliveries.$inferInsert;
import { OPS_SOURCE } from './constants';
import { EMAIL_CHANNEL, type EmailChannel } from './email.channel';

export interface NotifyInput {
  readonly tenantId: string;
  readonly propertyId: string;
  /** Preference bucket, e.g. TASK, ESCALATION, APPROVAL. */
  readonly category: string;
  /** Locale key prefix: `<key>.subject` and `<key>.body` are rendered per recipient (CLAUDE.md rule 7). */
  readonly templateKey: string;
  readonly params?: Record<string, string | number>;
  readonly to:
    | { readonly type: 'USER'; readonly userId: string }
    | { readonly type: 'ROLE'; readonly roleCode: string }
    | { readonly type: 'PERMISSION'; readonly permission: string };
  readonly priority?: NotificationPriority;
  readonly criticalOverride?: boolean;
  readonly source?: { readonly type: string; readonly id: string } | null;
}

const ERROR_MAX = 300;

/**
 * Notification intents and their deliveries (Spec §25). `notify` records what should be said to whom (in the caller's
 * transaction); the worker dispatches it into one delivery per person and channel (preferences and critical policy
 * applied) and sends external channels with retries. The in-app inbox reads the deliveries.
 */
@Injectable()
export class NotificationService {
  constructor(
    private readonly repo: NotificationRepositories,
    private readonly tx: TransactionRunner,
    private readonly events: EventPublisher,
    private readonly i18n: I18nService,
    @Inject(EMAIL_CHANNEL) private readonly email: EmailChannel,
    @Inject(IDENTITY_API) private readonly identity: IdentityPublicApi,
    @InjectLogger() private readonly logger: Logger,
  ) {}

  notify(input: NotifyInput): Promise<NotificationIntentRow> {
    return this.tx.run(async () => {
      const recipientRef =
        input.to.type === 'USER'
          ? input.to.userId
          : input.to.type === 'ROLE'
            ? input.to.roleCode
            : input.to.permission;
      const intent = await this.repo.insertIntent({
        id: newId(),
        tenantId: input.tenantId,
        propertyId: input.propertyId,
        category: input.category,
        templateKey: input.templateKey,
        params: input.params ?? {},
        recipientType: input.to.type,
        recipientRef,
        priority: input.priority ?? 'NORMAL',
        criticalOverride: input.criticalOverride ?? false,
        sourceType: input.source?.type ?? null,
        sourceId: input.source?.id ?? null,
      });
      await this.events.publish(NotificationRequested, {
        tenantId: intent.tenantId,
        propertyId: intent.propertyId,
        source: OPS_SOURCE,
        aggregate: { type: 'notification_intent', id: intent.id },
        payload: { intent_id: intent.id, category: intent.category, priority: intent.priority },
      });
      return intent;
    });
  }

  /** Expands an intent into deliveries (idempotent: a redelivered event adds nothing). Returns how many were added. */
  async dispatch(scope: TenantScope, intentId: string): Promise<number> {
    return this.tx.run(async () => {
      const intent = await this.repo.intentForUpdate(scope, intentId);
      if (!intent || intent.dispatchedAt) return 0;
      const users = await this.recipients(intent);
      const preferences = await this.repo.preferences(scope, users);
      const now = new Date();
      const rows = users.flatMap((userId) =>
        channelsFor(
          intent.priority,
          intent.criticalOverride,
          intent.category,
          preferences.filter((p) => p.userId === userId),
        ).map((channel) => this.delivery(intent, userId, channel, now)),
      );
      const added = await this.repo.insertDeliveries(rows);
      await this.repo.markDispatched(scope, intent.id, now);
      return added;
    });
  }

  /** Sends due external deliveries (e-mail) with retries; returns how many were attempted. */
  async deliverDue(now = new Date(), batch = 50): Promise<number> {
    let total = 0;
    for (;;) {
      const n = await this.tx.run(async () => {
        const due = await this.repo.claimDue(now, batch);
        for (const d of due) await this.send(d, now);
        return due.length;
      });
      total += n;
      if (n < batch) break;
    }
    return total;
  }

  private async send(d: NotificationDeliveryRow, now: Date): Promise<void> {
    const scope = { tenantId: d.tenantId };
    const [intent] = await this.repo.intents(scope, [d.intentId]);
    const contact = await this.identity.getStaffContact(d.tenantId, d.userId);
    if (!intent || !contact?.email) {
      await this.repo.updateDelivery(scope, d.id, { status: 'SKIPPED', lastError: 'no_address' });
      return;
    }
    const locale = contact.locale ?? undefined;
    try {
      const { providerRef } = await this.email.send({
        to: contact.email,
        subject: this.render(`${intent.templateKey}.subject`, intent.params, locale),
        text: this.render(`${intent.templateKey}.body`, intent.params, locale),
      });
      await this.repo.updateDelivery(scope, d.id, {
        status: 'SENT',
        sentAt: now,
        providerRef,
        attempts: d.attempts + 1,
        nextAttemptAt: null,
      });
    } catch (err) {
      const attempts = d.attempts + 1;
      const final = attempts >= MAX_DELIVERY_ATTEMPTS;
      // Transport errors may echo the address: keep the code/kind, not the message (no PII in tables or logs).
      const reason = errorCode(err);
      await this.repo.updateDelivery(scope, d.id, {
        status: final ? 'FAILED' : 'PENDING',
        attempts,
        lastError: reason,
        nextAttemptAt: final ? null : new Date(now.getTime() + retryDelayMs(attempts)),
      });
      this.logger.warn(
        { delivery_id: d.id, attempts, final, error: reason },
        'notification e-mail not delivered',
      );
    }
  }

  private delivery(
    intent: NotificationIntentRow,
    userId: string,
    channel: NotificationChannel,
    now: Date,
  ): NewDelivery {
    const base = {
      id: newId(),
      tenantId: intent.tenantId,
      propertyId: intent.propertyId,
      intentId: intent.id,
      userId,
      channel,
    };
    if (channel === 'IN_APP') return { ...base, status: 'SENT', sentAt: now };
    if (channel === 'EMAIL')
      return this.email.configured
        ? { ...base, status: 'PENDING', nextAttemptAt: now }
        : { ...base, status: 'SKIPPED', lastError: 'channel_not_configured' };
    return { ...base, status: 'SKIPPED', lastError: 'channel_not_available' };
  }

  private async recipients(intent: NotificationIntentRow): Promise<string[]> {
    const ids =
      intent.recipientType === 'USER'
        ? [intent.recipientRef]
        : intent.recipientType === 'ROLE'
          ? await this.identity.usersWithRole(
              intent.tenantId,
              intent.propertyId,
              intent.recipientRef,
            )
          : await this.identity.usersWithPermission(
              intent.tenantId,
              intent.propertyId,
              intent.recipientRef,
            );
    return [...new Set(ids)].filter(isUuid).sort();
  }

  render(key: string, params: Record<string, string | number>, locale?: string): string {
    return this.i18n.has(key, locale) ? this.i18n.t(key, params, locale) : key;
  }
}

function errorCode(err: unknown): string {
  const e = err as { code?: unknown; responseCode?: unknown; name?: unknown };
  const parts = [e.name, e.code, e.responseCode].filter(
    (p) => typeof p === 'string' || typeof p === 'number',
  );
  return (parts.join(':') || 'send_failed').slice(0, ERROR_MAX);
}

export const inboxQuerySchema = z.object({
  unread: z.stringbool().default(false),
  limit: z.coerce.number().int().min(1).max(100).default(30),
});
export const preferenceSchema = z.object({
  category: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z][A-Z0-9_]{1,31}$/),
  channel: z.enum(['IN_APP', 'EMAIL', 'PUSH', 'WHATSAPP', 'SMS']),
  enabled: z.boolean(),
});

/** A staff member's own notifications at a property and their channel preferences. */
@Injectable()
export class NotificationInboxService {
  constructor(
    private readonly repo: NotificationRepositories,
    private readonly notifications: NotificationService,
    private readonly gate: ActionGate,
    private readonly tx: TransactionRunner,
    private readonly actors: ActorStore,
    private readonly locale: CurrentLocale,
  ) {}

  inbox(scope: PropertyScope, query: z.infer<typeof inboxQuerySchema>) {
    return this.gate.execute(
      { action: 'notification.read', tenantId: scope.tenantId, propertyId: scope.propertyId },
      () =>
        this.tx.read(async () => {
          const me = this.actors.require().id;
          const rows = await this.repo.inbox(scope, me, {
            unreadOnly: query.unread,
            limit: query.limit,
          });
          const intents = new Map(
            (await this.repo.intents(scope, [...new Set(rows.map((r) => r.intentId))])).map((i) => [
              i.id,
              i,
            ]),
          );
          const locale = this.locale.get();
          return rows.map((r) => {
            const intent = intents.get(r.intentId)!;
            return {
              id: r.id,
              category: intent.category,
              priority: intent.priority,
              title: this.notifications.render(
                `${intent.templateKey}.subject`,
                intent.params,
                locale,
              ),
              body: this.notifications.render(`${intent.templateKey}.body`, intent.params, locale),
              source: intent.sourceType ? { type: intent.sourceType, id: intent.sourceId } : null,
              createdAt: r.createdAt,
              readAt: r.readAt,
            };
          });
        }),
    );
  }

  markRead(scope: PropertyScope, id: string) {
    return this.gate.execute(
      { action: 'notification.read', tenantId: scope.tenantId, propertyId: scope.propertyId },
      () =>
        this.tx.run(async () => {
          const ok =
            isUuid(id) &&
            (await this.repo.markRead(scope, id, this.actors.require().id, new Date()));
          if (!ok) throw AppError.notFound('ops.notification.not_found');
          return { id, read: true };
        }),
    );
  }

  preferences(scope: PropertyScope) {
    return this.gate.execute(
      {
        action: 'notification.preferences.manage',
        tenantId: scope.tenantId,
        propertyId: scope.propertyId,
      },
      () =>
        this.tx.read(async () =>
          (await this.repo.preferences(scope, [this.actors.require().id])).map((p) => ({
            category: p.category,
            channel: p.channel,
            enabled: p.enabled,
          })),
        ),
    );
  }

  setPreference(scope: PropertyScope, input: z.infer<typeof preferenceSchema>) {
    return this.gate.execute(
      {
        action: 'notification.preferences.manage',
        tenantId: scope.tenantId,
        propertyId: scope.propertyId,
      },
      () =>
        this.tx.run(async () => {
          await this.repo.upsertPreference({
            id: newId(),
            tenantId: scope.tenantId,
            userId: this.actors.require().id,
            category: input.category,
            channel: input.channel,
            enabled: input.enabled,
          });
          return input;
        }),
    );
  }
}
