import { defineManifest } from '@hotella/platform-manifest';

export const COMMUNICATIONS_MANIFEST = defineManifest({
  code: 'comms',
  schema: 'comms',
  description:
    'Communications & guest identity: channels behind provider adapters, channel identities, activation, OTP, room QR, conversations and the staff inbox.',
  permissions: [
    { code: 'channel.manage', descriptionKey: 'comms.permission.channel_manage', risk: 'HIGH' },
  ],
  events: [],
  localeNamespaces: ['comms'],
});
