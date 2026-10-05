import { z } from 'zod';
import {
  type ConnectorAdapter,
  defineConnector,
  type ParseResult,
  type RawInboundMessage,
} from '@hotella/contracts-connectors';

/**
 * Stay-bound access (ADR-0024 §5, BUILD_PLAN 13.3, rule 19): the vendor-neutral door-lock and Wi-Fi connectors
 * (Planova Lock and Wi-Fi Profiles v1). The platform only asks — encode a key, issue a mobile key, open a Wi-Fi
 * session, revoke it — over the agent link, each command naming the platform's grant; the key or credential itself
 * stays with the vendor system and reaches the guest from there (card encoder, mobile key app, captive portal).
 * A vendor system (owner decision Q25) is a later connector answering the same commands.
 */
const grantId = z.uuid();
const roomNumber = z.string().min(1).max(16);
const until = z.iso.datetime({ offset: true });

export const LOCK_STANDARD_MANIFEST = defineConnector({
  code: 'LOCK_STANDARD',
  version: 1,
  category: 'LOCK',
  entitlement: 'CONNECTOR_LOCK',
  description:
    'Door locks (Planova Lock Profile v1): room keys and mobile keys for in-house stays.',
  capabilities: ['KEY_ENCODE', 'KEY_REVOKE', 'MOBILE_KEY_ISSUE'],
  messageTypes: [],
  commands: [
    {
      code: 'KEY_ENCODE',
      description: 'Encode a room key (card) valid until the given instant.',
      requires: 'KEY_ENCODE',
      payload: z
        .object({ grant_id: grantId, room_number: roomNumber, valid_until: until })
        .strict(),
    },
    {
      code: 'MOBILE_KEY_ISSUE',
      description: "Issue a mobile key to the guest's device through the lock vendor's app.",
      requires: 'MOBILE_KEY_ISSUE',
      payload: z
        .object({ grant_id: grantId, room_number: roomNumber, valid_until: until })
        .strict(),
    },
    {
      code: 'KEY_REVOKE',
      description: 'Revoke every key issued for the grant (card or mobile).',
      requires: 'KEY_REVOKE',
      payload: z.object({ grant_id: grantId }).strict(),
    },
  ],
  configSchema: z.object({ label: z.string().max(200).optional() }),
  credentialSchema: z.object({}),
});

export const WIFI_STANDARD_MANIFEST = defineConnector({
  code: 'WIFI_STANDARD',
  version: 1,
  category: 'WIFI',
  entitlement: 'CONNECTOR_WIFI',
  description: 'Guest Wi-Fi (Planova Wi-Fi Profile v1): a session for an in-house stay.',
  capabilities: ['WIFI_SESSION_CREATE', 'WIFI_SESSION_REVOKE'],
  messageTypes: [],
  commands: [
    {
      code: 'WIFI_SESSION_CREATE',
      description: 'Open a Wi-Fi session for the stay, valid until the given instant.',
      requires: 'WIFI_SESSION_CREATE',
      payload: z
        .object({ grant_id: grantId, room_number: roomNumber, valid_until: until })
        .strict(),
    },
    {
      code: 'WIFI_SESSION_REVOKE',
      description: "End the grant's Wi-Fi session.",
      requires: 'WIFI_SESSION_REVOKE',
      payload: z.object({ grant_id: grantId }).strict(),
    },
  ],
  configSchema: z.object({ label: z.string().max(200).optional() }),
  credentialSchema: z.object({}),
});

/** Command-only connectors: nothing inbound to parse. */
const commandOnly = (manifest: typeof LOCK_STANDARD_MANIFEST): ConnectorAdapter => ({
  manifest,
  parse(message: RawInboundMessage): ParseResult {
    return { ok: false, error: `unsupported message type ${message.message_type}` };
  },
});

export const lockStandardAdapter = commandOnly(LOCK_STANDARD_MANIFEST);
export const wifiStandardAdapter = commandOnly(WIFI_STANDARD_MANIFEST);
