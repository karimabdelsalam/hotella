import { z } from 'zod';
import { defineEvent } from './registry';

/**
 * Communications events (Spec §18). Payloads carry ids and states only — never message text, phone numbers or names;
 * consumers that need content read it through the communications context.
 */

const channelType = z.enum([
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

export const ConversationOpened = defineEvent({
  type: 'comms.conversation.opened',
  version: 1,
  delivery: 'guest-realtime',
  description:
    'A guest conversation opened (stay-bound when the sender is verified with a live grant).',
  payload: z.object({
    conversation_id: z.uuid(),
    guest_id: z.uuid().nullable(),
    stay_id: z.uuid().nullable(),
    channel_type: channelType,
  }),
});

export const MessageReceived = defineEvent({
  type: 'comms.message.received',
  version: 1,
  delivery: 'guest-realtime',
  description:
    'A guest message arrived in a conversation (Phase 6 AI and the staff inbox react to it).',
  payload: z.object({
    conversation_id: z.uuid(),
    message_id: z.uuid(),
    guest_id: z.uuid().nullable(),
    stay_id: z.uuid().nullable(),
    channel_type: channelType,
    message_type: z.string().max(16),
  }),
});

export const MessageSent = defineEvent({
  type: 'comms.message.sent',
  version: 1,
  delivery: 'guest-realtime',
  description: 'An outbound message left through its channel (or was shown on guest web).',
  payload: z.object({
    conversation_id: z.uuid(),
    message_id: z.uuid(),
    channel_type: channelType,
    sender_type: z.enum(['GUEST', 'STAFF', 'AI', 'SYSTEM', 'EXTERNAL']),
  }),
});

export const DeliveryUpdated = defineEvent({
  type: 'comms.delivery.updated',
  version: 1,
  delivery: 'normal',
  description:
    'A provider receipt moved an outbound message forward (DELIVERED, READ) or failed it.',
  payload: z.object({
    conversation_id: z.uuid(),
    message_id: z.uuid(),
    status: z.enum(['SENT', 'DELIVERED', 'READ', 'FAILED']),
    error_code: z.string().max(32).nullable(),
  }),
});

/** Staff sent an AI draft (edited or not): the AI context records how much it was changed (Spec §40). */
export const ReplyDraftUsed = defineEvent({
  type: 'comms.reply_draft.used',
  version: 1,
  description:
    'Staff sent a reply based on an AI draft; carries the edit distance between the draft and what was sent.',
  payload: z.object({
    draft_id: z.uuid(),
    conversation_id: z.uuid(),
    execution_id: z.uuid().nullable(),
    agent_code: z.string().max(64),
    edit_distance: z.number().int().min(0),
    draft_length: z.number().int().min(0),
    sent_length: z.number().int().min(0),
    used_by: z.uuid().nullable(),
  }),
});

export const HandoffRequested = defineEvent({
  type: 'comms.handoff.requested',
  version: 1,
  delivery: 'guest-realtime',
  description:
    'A conversation moved to a person (staff takeover or AI escalation); AI auto mode is off from here.',
  payload: z.object({
    conversation_id: z.uuid(),
    stay_id: z.uuid().nullable(),
    by: z.enum(['STAFF', 'AI', 'SYSTEM']),
    assigned_user_id: z.uuid().nullable(),
  }),
});
