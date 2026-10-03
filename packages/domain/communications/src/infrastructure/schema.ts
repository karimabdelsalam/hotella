import { sql } from 'drizzle-orm';
import {
  boolean,
  index,
  integer,
  jsonb,
  pgSchema,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
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

// ---- activation (Spec §19–§20, ADR-0011, ADR-0015) ----

export const otpChannel = comms.enum('otp_channel', ['WHATSAPP', 'SMS', 'VOICE', 'STAFF']);
export const verificationDeliveryStatus = comms.enum('verification_delivery_status', [
  'SENT',
  'DELIVERED',
  'READ',
  'FAILED',
]);
export const verificationTrigger = comms.enum('verification_trigger', [
  'INITIAL',
  'AUTO_FALLBACK',
  'MANUAL_FALLBACK',
  'STAFF_ASSIST',
]);
export const qrStatus = comms.enum('qr_status', ['ACTIVE', 'ROTATED', 'REVOKED']);

/**
 * Single-purpose, single-use activation links minted by the platform, never by the PMS (Spec §19.1). 256-bit tokens,
 * SHA-256 at rest; issuing a new one for the same stay and guest revokes the previous one.
 */
export const activationTokens = classify(
  comms.table(
    'activation_tokens',
    {
      ...baseColumns(),
      tenantId: uuid('tenant_id').notNull(),
      propertyId: uuid('property_id').notNull(),
      stayId: uuid('stay_id').notNull(),
      /** The party member it was issued for; null = whoever verifies (matched by phone, else the primary guest). */
      guestId: uuid('guest_id'),
      tokenHash: varchar('token_hash', { length: 64 }).notNull(),
      purpose: varchar('purpose', { length: 32 }).notNull().default('GUEST_ACTIVATION'),
      deliveredVia: varchar('delivered_via', { length: 16 }).notNull(),
      expiresAt: tz('expires_at').notNull(),
      usedAt: tz('used_at'),
      revokedAt: tz('revoked_at'),
      createdByType: varchar('created_by_type', { length: 16 }).notNull(),
      createdById: varchar('created_by_id', { length: 64 }),
    },
    (t) => [
      uniqueIndex('activation_tokens_hash_uq').on(t.tokenHash),
      index('activation_tokens_stay_idx').on(t.tenantId, t.stayId),
    ],
  ),
  {
    id: 'INTERNAL',
    createdAt: 'INTERNAL',
    updatedAt: 'INTERNAL',
    tenantId: 'INTERNAL',
    propertyId: 'INTERNAL',
    stayId: 'INTERNAL',
    guestId: 'INTERNAL',
    tokenHash: 'RESTRICTED',
    purpose: 'INTERNAL',
    deliveredVia: 'INTERNAL',
    expiresAt: 'INTERNAL',
    usedAt: 'INTERNAL',
    revokedAt: 'INTERNAL',
    createdByType: 'INTERNAL',
    createdById: 'INTERNAL',
  },
);

/**
 * One OTP verification of a phone number for a stay, across every delivery channel (ADR-0015): one code, one attempt
 * counter, one expiry. The code is derived from `otp_seed` under the OTP key (a SecretRef) and never stored.
 */
export const verificationSessions = classify(
  comms.table(
    'verification_sessions',
    {
      ...baseColumns(),
      tenantId: uuid('tenant_id').notNull(),
      propertyId: uuid('property_id').notNull(),
      stayId: uuid('stay_id').notNull(),
      roomId: uuid('room_id'),
      /** The party member being verified. */
      guestId: uuid('guest_id').notNull(),
      activationTokenId: uuid('activation_token_id').references(() => activationTokens.id),
      roomQrCodeId: uuid('room_qr_code_id'),
      phoneNormalized: varchar('phone_normalized', { length: 20 }).notNull(),
      otpSeed: varchar('otp_seed', { length: 64 }).notNull(),
      /** SHA-256 of the 256-bit handle the guest's device uses for this session (the id alone is not a secret). */
      handleHash: varchar('handle_hash', { length: 64 }).notNull(),
      locale: varchar('locale', { length: 16 }).notNull(),
      /** Short code the guest reads to front desk for staff-assisted verification. */
      reference: varchar('reference', { length: 8 }).notNull(),
      attempts: integer('attempts').notNull().default(0),
      maxAttempts: integer('max_attempts').notNull(),
      expiresAt: tz('expires_at').notNull(),
      verifiedAt: tz('verified_at'),
      verifiedVia: otpChannel('verified_via'),
      lockedAt: tz('locked_at'),
      assistedByUserId: uuid('assisted_by_user_id'),
      /** Set once the verified session became a guest session: a session completes exactly once. */
      completedAt: tz('completed_at'),
      ...versioned(),
    },
    (t) => [
      uniqueIndex('verification_sessions_handle_uq').on(t.handleHash),
      index('verification_sessions_phone_idx').on(t.tenantId, t.phoneNormalized, t.createdAt),
      index('verification_sessions_open_idx')
        .on(t.expiresAt)
        .where(sql`${t.verifiedAt} IS NULL AND ${t.lockedAt} IS NULL`),
      index('verification_sessions_reference_idx').on(t.propertyId, t.reference),
    ],
  ),
  {
    id: 'INTERNAL',
    createdAt: 'INTERNAL',
    updatedAt: 'INTERNAL',
    tenantId: 'INTERNAL',
    propertyId: 'INTERNAL',
    stayId: 'INTERNAL',
    roomId: 'INTERNAL',
    guestId: 'INTERNAL',
    activationTokenId: 'INTERNAL',
    roomQrCodeId: 'INTERNAL',
    phoneNormalized: 'SENSITIVE',
    otpSeed: 'RESTRICTED',
    handleHash: 'RESTRICTED',
    locale: 'INTERNAL',
    reference: 'INTERNAL',
    attempts: 'INTERNAL',
    maxAttempts: 'INTERNAL',
    expiresAt: 'INTERNAL',
    verifiedAt: 'INTERNAL',
    verifiedVia: 'INTERNAL',
    lockedAt: 'INTERNAL',
    assistedByUserId: 'INTERNAL',
    completedAt: 'INTERNAL',
    version: 'INTERNAL',
  },
);

/** Every delivery attempt of a session's code (ADR-0015); the provider's error message is never kept. */
export const verificationDeliveries = classify(
  comms.table(
    'verification_deliveries',
    {
      ...baseColumns(),
      tenantId: uuid('tenant_id').notNull(),
      sessionId: uuid('session_id')
        .notNull()
        .references(() => verificationSessions.id),
      channel: otpChannel('channel').notNull(),
      channelId: uuid('channel_id').references(() => channels.id),
      providerCode: varchar('provider_code', { length: 64 }),
      trigger: verificationTrigger('trigger').notNull(),
      status: verificationDeliveryStatus('status').notNull(),
      providerRef: varchar('provider_ref', { length: 128 }),
      errorCode: varchar('error_code', { length: 32 }),
      sentAt: tz('sent_at').notNull(),
      statusAt: tz('status_at').notNull(),
    },
    (t) => [
      index('verification_deliveries_session_idx').on(t.sessionId, t.sentAt),
      index('verification_deliveries_provider_idx').on(t.channelId, t.providerRef),
    ],
  ),
  {
    id: 'INTERNAL',
    createdAt: 'INTERNAL',
    updatedAt: 'INTERNAL',
    tenantId: 'INTERNAL',
    sessionId: 'INTERNAL',
    channel: 'INTERNAL',
    channelId: 'INTERNAL',
    providerCode: 'INTERNAL',
    trigger: 'INTERNAL',
    status: 'INTERNAL',
    providerRef: 'INTERNAL',
    errorCode: 'INTERNAL',
    sentAt: 'INTERNAL',
    statusAt: 'INTERNAL',
  },
);

/**
 * Static room QR codes (Spec §20): an opaque token resolving to a room, never to a guest or stay. Rotation and
 * revocation invalidate printed codes without any PMS change. One ACTIVE code per room.
 */
export const roomQrCodes = classify(
  comms.table(
    'room_qr_codes',
    {
      ...baseColumns(),
      tenantId: uuid('tenant_id').notNull(),
      propertyId: uuid('property_id').notNull(),
      roomId: uuid('room_id').notNull(),
      tokenHash: varchar('token_hash', { length: 64 }).notNull(),
      status: qrStatus('status').notNull().default('ACTIVE'),
      rotatedFromId: uuid('rotated_from_id'),
      statusChangedAt: tz('status_changed_at'),
    },
    (t) => [
      uniqueIndex('room_qr_codes_hash_uq').on(t.tokenHash),
      uniqueIndex('room_qr_codes_active_uq')
        .on(t.roomId)
        .where(sql`${t.status} = 'ACTIVE'`),
      index('room_qr_codes_property_idx').on(t.tenantId, t.propertyId),
    ],
  ),
  {
    id: 'INTERNAL',
    createdAt: 'INTERNAL',
    updatedAt: 'INTERNAL',
    tenantId: 'INTERNAL',
    propertyId: 'INTERNAL',
    roomId: 'INTERNAL',
    tokenHash: 'RESTRICTED',
    status: 'INTERNAL',
    rotatedFromId: 'INTERNAL',
    statusChangedAt: 'INTERNAL',
  },
);

// ---- conversations (Spec §18.2, BUILD_PLAN §8.1) ----

export const inboundStatus = comms.enum('inbound_status', ['RECEIVED', 'PROCESSED', 'FAILED']);
export const conversationStatus = comms.enum('conversation_status', [
  'OPEN',
  'WAITING_GUEST',
  'WAITING_STAFF',
  'HANDED_OFF',
  'CLOSED',
]);
export const conversationSubject = comms.enum('conversation_subject', ['GUEST', 'STAFF_INTERNAL']);
export const aiMode = comms.enum('ai_mode', ['OFF', 'ASSIST', 'AUTO']);
export const participantType = comms.enum('participant_type', [
  'GUEST',
  'STAFF',
  'AI',
  'SYSTEM',
  'EXTERNAL',
]);
export const messageDirection = comms.enum('message_direction', ['INBOUND', 'OUTBOUND']);
export const messageType = comms.enum('message_type', [
  'TEXT',
  'IMAGE',
  'AUDIO',
  'VIDEO',
  'DOCUMENT',
  'LOCATION',
  'INTERACTIVE',
  'SYSTEM',
]);
export const deliveryStatus = comms.enum('delivery_status', [
  'QUEUED',
  'SENT',
  'DELIVERED',
  'READ',
  'FAILED',
]);

/**
 * Provider webhooks after signature verification, one row per normalized item (message or receipt), stored before
 * anything else happens; a repeated provider id is a no-op. Not domain events (CLAUDE.md rule 6).
 */
export const inboundEvents = classify(
  comms.table(
    'inbound_events',
    {
      ...baseColumns(),
      tenantId: uuid('tenant_id').notNull(),
      propertyId: uuid('property_id').notNull(),
      channelId: uuid('channel_id')
        .notNull()
        .references(() => channels.id),
      providerEventId: varchar('provider_event_id', { length: 160 }).notNull(),
      payload: jsonb('payload').notNull(),
      receivedAt: tz('received_at').notNull(),
      status: inboundStatus('status').notNull().default('RECEIVED'),
      attempts: integer('attempts').notNull().default(0),
      processedAt: tz('processed_at'),
      errorCode: varchar('error_code', { length: 32 }),
    },
    (t) => [
      unique('inbound_events_provider_uq').on(t.channelId, t.providerEventId),
      index('inbound_events_pending_idx')
        .on(t.receivedAt)
        .where(sql`${t.status} = 'RECEIVED'`),
    ],
  ),
  {
    id: 'INTERNAL',
    createdAt: 'INTERNAL',
    updatedAt: 'INTERNAL',
    tenantId: 'INTERNAL',
    propertyId: 'INTERNAL',
    channelId: 'INTERNAL',
    providerEventId: 'INTERNAL',
    payload: 'CONFIDENTIAL',
    receivedAt: 'INTERNAL',
    status: 'INTERNAL',
    attempts: 'INTERNAL',
    processedAt: 'INTERNAL',
    errorCode: 'INTERNAL',
  },
);

/**
 * A conversation is a business concept independent of channel (Spec §18.2): a stay-bound conversation collects WhatsApp
 * and guest-web messages of that stay; replies leave on the channel the guest last wrote on. Unverified contacts get
 * their own conversation keyed by the channel identity (never linked to a stay on the phone's word).
 */
export const conversations = classify(
  comms.table(
    'conversations',
    {
      ...baseColumns(),
      tenantId: uuid('tenant_id').notNull(),
      propertyId: uuid('property_id').notNull(),
      subjectType: conversationSubject('subject_type').notNull().default('GUEST'),
      guestId: uuid('guest_id'),
      stayId: uuid('stay_id'),
      channelIdentityId: uuid('channel_identity_id').references(() => channelIdentities.id),
      /** Where replies go: the channel the guest last wrote on (null = guest web). */
      replyChannelId: uuid('reply_channel_id').references(() => channels.id),
      replyChannelType: channelType('reply_channel_type').notNull(),
      status: conversationStatus('status').notNull().default('WAITING_STAFF'),
      assignedUserId: uuid('assigned_user_id'),
      aiMode: aiMode('ai_mode').notNull().default('OFF'),
      handoffReason: varchar('handoff_reason', { length: 200 }),
      lastMessageAt: tz('last_message_at').notNull(),
      /** WhatsApp's customer-service window: free-form replies only within 24 h of the guest's last message. */
      lastInboundAt: tz('last_inbound_at'),
      activationPromptedAt: tz('activation_prompted_at'),
      closedAt: tz('closed_at'),
      ...versioned(),
    },
    (t) => [
      uniqueIndex('conversations_open_stay_uq')
        .on(t.stayId)
        .where(sql`${t.status} <> 'CLOSED' AND ${t.stayId} IS NOT NULL`),
      uniqueIndex('conversations_open_identity_uq')
        .on(t.channelIdentityId)
        .where(sql`${t.status} <> 'CLOSED' AND ${t.stayId} IS NULL`),
      index('conversations_inbox_idx').on(t.tenantId, t.propertyId, t.status, t.lastMessageAt),
    ],
  ),
  {
    id: 'INTERNAL',
    createdAt: 'INTERNAL',
    updatedAt: 'INTERNAL',
    tenantId: 'INTERNAL',
    propertyId: 'INTERNAL',
    subjectType: 'INTERNAL',
    guestId: 'INTERNAL',
    stayId: 'INTERNAL',
    channelIdentityId: 'INTERNAL',
    replyChannelId: 'INTERNAL',
    replyChannelType: 'INTERNAL',
    status: 'INTERNAL',
    assignedUserId: 'INTERNAL',
    aiMode: 'INTERNAL',
    handoffReason: 'CONFIDENTIAL',
    lastMessageAt: 'INTERNAL',
    lastInboundAt: 'INTERNAL',
    activationPromptedAt: 'INTERNAL',
    closedAt: 'INTERNAL',
    version: 'INTERNAL',
  },
);

export const conversationParticipants = classify(
  comms.table(
    'conversation_participants',
    {
      ...baseColumns(),
      tenantId: uuid('tenant_id').notNull(),
      conversationId: uuid('conversation_id')
        .notNull()
        .references(() => conversations.id),
      participantType: participantType('participant_type').notNull(),
      /** Guest id, staff user id or agent id; null for SYSTEM and unverified contacts. */
      participantRef: varchar('participant_ref', { length: 64 }),
      joinedAt: tz('joined_at').notNull(),
      leftAt: tz('left_at'),
    },
    (t) => [index('conversation_participants_conversation_idx').on(t.conversationId)],
  ),
  {
    id: 'INTERNAL',
    createdAt: 'INTERNAL',
    updatedAt: 'INTERNAL',
    tenantId: 'INTERNAL',
    conversationId: 'INTERNAL',
    participantType: 'INTERNAL',
    participantRef: 'INTERNAL',
    joinedAt: 'INTERNAL',
    leftAt: 'INTERNAL',
  },
);

/** Messages are append-only history; only delivery fields of outbound messages change (Spec §18.2). */
export const messages = classify(
  comms.table(
    'messages',
    {
      ...baseColumns(),
      tenantId: uuid('tenant_id').notNull(),
      conversationId: uuid('conversation_id')
        .notNull()
        .references(() => conversations.id),
      channelId: uuid('channel_id').references(() => channels.id),
      channelType: channelType('channel_type').notNull(),
      direction: messageDirection('direction').notNull(),
      senderParticipantId: uuid('sender_participant_id').references(
        () => conversationParticipants.id,
      ),
      senderType: participantType('sender_type').notNull(),
      senderRef: varchar('sender_ref', { length: 64 }),
      type: messageType('type').notNull(),
      body: text('body'),
      /** Provider media id; fetched on demand into the asset registry later (never trusted as an instruction). */
      mediaRef: varchar('media_ref', { length: 256 }),
      mediaAssetId: uuid('media_asset_id'),
      localeDetected: varchar('locale_detected', { length: 16 }),
      providerMessageId: varchar('provider_message_id', { length: 160 }),
      replyToMessageId: uuid('reply_to_message_id'),
      deliveryStatus: deliveryStatus('delivery_status').notNull(),
      attempts: integer('attempts').notNull().default(0),
      nextAttemptAt: tz('next_attempt_at'),
      errorCode: varchar('error_code', { length: 32 }),
      /** Shown to the guest (false for staff-only notes and system markers). */
      guestVisible: boolean('guest_visible').notNull().default(true),
    },
    (t) => [
      index('messages_conversation_idx').on(t.conversationId, t.id),
      uniqueIndex('messages_provider_uq')
        .on(t.channelId, t.providerMessageId)
        .where(sql`${t.providerMessageId} IS NOT NULL`),
      index('messages_outbox_idx')
        .on(t.nextAttemptAt)
        .where(sql`${t.deliveryStatus} = 'QUEUED'`),
    ],
  ),
  {
    id: 'INTERNAL',
    createdAt: 'INTERNAL',
    updatedAt: 'INTERNAL',
    tenantId: 'INTERNAL',
    conversationId: 'INTERNAL',
    channelId: 'INTERNAL',
    channelType: 'INTERNAL',
    direction: 'INTERNAL',
    senderParticipantId: 'INTERNAL',
    senderType: 'INTERNAL',
    senderRef: 'INTERNAL',
    type: 'INTERNAL',
    body: 'CONFIDENTIAL',
    mediaRef: 'CONFIDENTIAL',
    mediaAssetId: 'INTERNAL',
    localeDetected: 'INTERNAL',
    providerMessageId: 'INTERNAL',
    replyToMessageId: 'INTERNAL',
    deliveryStatus: 'INTERNAL',
    attempts: 'INTERNAL',
    nextAttemptAt: 'INTERNAL',
    errorCode: 'INTERNAL',
    guestVisible: 'INTERNAL',
  },
);

/** Delivery lifecycle of outbound messages (QUEUED → SENT → DELIVERED → READ | FAILED). */
export const messageDeliveryEvents = classify(
  comms.table(
    'message_delivery_events',
    {
      ...baseColumns(),
      tenantId: uuid('tenant_id').notNull(),
      messageId: uuid('message_id')
        .notNull()
        .references(() => messages.id),
      status: deliveryStatus('status').notNull(),
      errorCode: varchar('error_code', { length: 32 }),
      occurredAt: tz('occurred_at').notNull(),
    },
    (t) => [index('message_delivery_events_message_idx').on(t.messageId, t.occurredAt)],
  ),
  {
    id: 'INTERNAL',
    createdAt: 'INTERNAL',
    updatedAt: 'INTERNAL',
    tenantId: 'INTERNAL',
    messageId: 'INTERNAL',
    status: 'INTERNAL',
    errorCode: 'INTERNAL',
    occurredAt: 'INTERNAL',
  },
);

export type InboundEventRow = typeof inboundEvents.$inferSelect;
export type ConversationRow = typeof conversations.$inferSelect;
export type ParticipantRow = typeof conversationParticipants.$inferSelect;
export type MessageRow = typeof messages.$inferSelect;
export type ChannelRow = typeof channels.$inferSelect;
export type ActivationTokenRow = typeof activationTokens.$inferSelect;
export type VerificationSessionRow = typeof verificationSessions.$inferSelect;
export type VerificationDeliveryRow = typeof verificationDeliveries.$inferSelect;
export type RoomQrCodeRow = typeof roomQrCodes.$inferSelect;
export type ChannelIdentityRow = typeof channelIdentities.$inferSelect;
