/**
 * Notification channel selection (Spec §25), deterministic: the priority decides the default channels, a person's
 * preferences may switch channels off for a category, and critical operational policy overrides those preferences.
 */

export type NotificationPriority = 'NORMAL' | 'HIGH' | 'CRITICAL';
export type NotificationChannel = 'IN_APP' | 'EMAIL' | 'PUSH' | 'WHATSAPP' | 'SMS';

/** Staff channels available in this phase; PUSH arrives with the staff app, WHATSAPP/SMS with Phase 4 adapters. */
export const DEFAULT_CHANNELS: Record<NotificationPriority, readonly NotificationChannel[]> = {
  NORMAL: ['IN_APP'],
  HIGH: ['IN_APP', 'EMAIL'],
  CRITICAL: ['IN_APP', 'EMAIL'],
};

export interface ChannelPreference {
  readonly category: string;
  readonly channel: NotificationChannel;
  readonly enabled: boolean;
}

export function channelsFor(
  priority: NotificationPriority,
  criticalOverride: boolean,
  category: string,
  preferences: readonly ChannelPreference[],
): NotificationChannel[] {
  const defaults = DEFAULT_CHANNELS[priority];
  if (criticalOverride && priority === 'CRITICAL') return [...defaults];
  return defaults.filter(
    (channel) =>
      !preferences.some((p) => p.category === category && p.channel === channel && !p.enabled),
  );
}

/** Retry schedule of a failed delivery: 1, 2, 4, 8 minutes, then it stays FAILED. */
export const MAX_DELIVERY_ATTEMPTS = 5;
export function retryDelayMs(attempts: number): number {
  return 60_000 * 2 ** Math.max(0, attempts - 1);
}
