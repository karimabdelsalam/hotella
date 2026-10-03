import {
  ConversationOpened,
  DeliveryUpdated,
  HandoffRequested,
  ReplyDraftUsed,
  MessageReceived,
  MessageSent,
} from '@hotella/contracts-events';
import { defineManifest } from '@hotella/platform-manifest';

export const COMMUNICATIONS_MANIFEST = defineManifest({
  code: 'comms',
  schema: 'comms',
  description:
    'Communications & guest identity: channels behind provider adapters, channel identities, activation, OTP, room QR, conversations and the staff inbox.',
  permissions: [
    { code: 'channel.manage', descriptionKey: 'comms.permission.channel_manage', risk: 'HIGH' },
    {
      code: 'guest.activation.issue',
      descriptionKey: 'comms.permission.activation_issue',
      risk: 'MEDIUM',
    },
    {
      code: 'guest.activation.assist',
      descriptionKey: 'comms.permission.activation_assist',
      risk: 'HIGH',
    },
    { code: 'qr.manage', descriptionKey: 'comms.permission.qr_manage', risk: 'MEDIUM' },
    { code: 'inbox.read', descriptionKey: 'comms.permission.inbox_read', risk: 'READ' },
    { code: 'inbox.reply', descriptionKey: 'comms.permission.inbox_reply', risk: 'LOW' },
    { code: 'inbox.assign', descriptionKey: 'comms.permission.inbox_assign', risk: 'LOW' },
    { code: 'inbox.takeover', descriptionKey: 'comms.permission.inbox_takeover', risk: 'MEDIUM' },
  ],
  events: [
    ConversationOpened.name,
    MessageReceived.name,
    MessageSent.name,
    DeliveryUpdated.name,
    HandoffRequested.name,
    ReplyDraftUsed.name,
  ],
  localeNamespaces: ['comms'],
});
