import { sql } from 'drizzle-orm';
import { index, jsonb, pgSchema, timestamp, unique, uuid, varchar } from 'drizzle-orm/pg-core';
import { baseColumns, classify, versioned } from '@hotella/platform-database';

/**
 * Communications & guest identity (Spec §18–§22, schema `comms`). Foreign keys to `org.*` and `guest.*` are added by
 * hand in the migrations. Phone numbers are stored only normalized (E.164) and classified SENSITIVE.
 */
export const comms = pgSchema('comms');

const tz = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

export const channelType = comms.enum('channel_type', [
  'WHATSAPP',
  'SMS',
  'EMAIL',
  'GUEST_WEB',
  'ROOM_QR',
  'VOICE',
  'MESSENGER',
  'INSTAGRAM',
  'APP',
]);
export const channelStatus = comms.enum('channel_status', ['ACTIVE', 'DISABLED']);
export const channelHealth = comms.enum('channel_health', [
  'HEALTHY',
  'DEGRADED',
  'OFFLINE',
  'AUTH_FAILED',
]);

/** A property's channel bound to one provider adapter (ADR-0015). Credentials are a SecretRef, never a value. */
export const channels = classify(
  comms.table(
    'channels',
    {
      ...baseColumns(),
      tenantId: uuid('tenant_id').notNull(),
      propertyId: uuid('property_id').notNull(),
      type: channelType('type').notNull(),
      name: varchar('name', { length: 80 }).notNull(),
      providerCode: varchar('provider_code', { length: 64 }).notNull(),
      /** Adapter configuration (sender ids, template ids, phone number id); validated by the adapter's schema. */
      config: jsonb('config').notNull().default({}),
      credentialRef: varchar('credential_ref', { length: 256 }),
      status: channelStatus('status').notNull().default('ACTIVE'),
      health: channelHealth('health').notNull().default('HEALTHY'),
      healthChangedAt: tz('health_changed_at'),
      brandProfileId: uuid('brand_profile_id'),
      ...versioned(),
    },
    (t) => [
      unique('channels_property_name_uq').on(t.propertyId, t.name),
      index('channels_property_type_idx').on(t.tenantId, t.propertyId, t.type),
    ],
  ),
  {
    id: 'INTERNAL',
    createdAt: 'INTERNAL',
    updatedAt: 'INTERNAL',
    tenantId: 'INTERNAL',
    propertyId: 'INTERNAL',
    type: 'INTERNAL',
    name: 'INTERNAL',
    providerCode: 'INTERNAL',
    config: 'INTERNAL',
    credentialRef: 'CONFIDENTIAL',
    status: 'INTERNAL',
    health: 'INTERNAL',
    healthChangedAt: 'INTERNAL',
    brandProfileId: 'INTERNAL',
    version: 'INTERNAL',
  },
);

/**
 * A contact point on a channel type (a WhatsApp number, an e-mail address) and the guest it was verified for.
 * Identity is not authorization (Spec §18.3): access always needs a live grant. One row per identifier per tenant.
 */
export const channelIdentities = classify(
  comms.table(
    'channel_identities',
    {
      ...baseColumns(),
      tenantId: uuid('tenant_id').notNull(),
      channelType: channelType('channel_type').notNull(),
      identifierNormalized: varchar('identifier_normalized', { length: 320 }).notNull(),
      guestId: uuid('guest_id'),
      verifiedAt: tz('verified_at'),
      lastSeenAt: tz('last_seen_at'),
      ...versioned(),
    },
    (t) => [
      unique('channel_identities_identifier_uq').on(
        t.tenantId,
        t.channelType,
        t.identifierNormalized,
      ),
      index('channel_identities_guest_idx')
        .on(t.tenantId, t.guestId)
        .where(sql`${t.guestId} IS NOT NULL`),
    ],
  ),
  {
    id: 'INTERNAL',
    createdAt: 'INTERNAL',
    updatedAt: 'INTERNAL',
    tenantId: 'INTERNAL',
    channelType: 'INTERNAL',
    identifierNormalized: 'SENSITIVE',
    guestId: 'INTERNAL',
    verifiedAt: 'INTERNAL',
    lastSeenAt: 'INTERNAL',
    version: 'INTERNAL',
  },
);

export type ChannelRow = typeof channels.$inferSelect;
export type ChannelIdentityRow = typeof channelIdentities.$inferSelect;
