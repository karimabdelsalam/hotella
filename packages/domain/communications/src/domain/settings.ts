import { z } from 'zod';
import { defineSetting } from '@hotella/platform-settings';
import type { OtpChannel } from './otp';

/** Settings owned by the communications context (ADR-0015, Spec §73); registered by CommunicationsModule. */
const SCOPES = ['PLATFORM', 'TENANT', 'PROPERTY'] as const;
const channel = z.enum(['WHATSAPP', 'SMS', 'VOICE']);

export const COMMS_OTP_PRIMARY_CHANNEL = defineSetting<OtpChannel>({
  key: 'comms.otp.primary_channel',
  scopes: SCOPES,
  schema: channel,
  default: 'WHATSAPP',
  descriptionKey: 'comms.setting.otp_primary_channel',
});
export const COMMS_OTP_FALLBACK_CHANNELS = defineSetting<OtpChannel[]>({
  key: 'comms.otp.fallback_channels',
  scopes: SCOPES,
  schema: z.array(channel).max(3),
  default: ['SMS'],
  descriptionKey: 'comms.setting.otp_fallback_channels',
});
export const COMMS_OTP_FALLBACK_TIMEOUT_SECONDS = defineSetting({
  key: 'comms.otp.fallback_timeout_seconds',
  scopes: SCOPES,
  schema: z.number().int().min(5).max(300),
  default: 20,
  descriptionKey: 'comms.setting.otp_fallback_timeout_seconds',
});
export const COMMS_OTP_MANUAL_FALLBACK_AFTER_SECONDS = defineSetting({
  key: 'comms.otp.manual_fallback_after_seconds',
  scopes: SCOPES,
  schema: z.number().int().min(10).max(600),
  default: 30,
  descriptionKey: 'comms.setting.otp_manual_fallback_after_seconds',
});
export const COMMS_OTP_STAFF_ASSIST_ENABLED = defineSetting({
  key: 'comms.otp.staff_assist_enabled',
  scopes: SCOPES,
  schema: z.boolean(),
  default: true,
  descriptionKey: 'comms.setting.otp_staff_assist_enabled',
});
export const COMMS_ACTIVATION_TOKEN_TTL_HOURS = defineSetting({
  key: 'comms.activation.token_ttl_hours',
  scopes: SCOPES,
  schema: z.number().int().min(1).max(168),
  default: 24,
  descriptionKey: 'comms.setting.activation_token_ttl_hours',
});

export const COMMUNICATIONS_SETTINGS = [
  COMMS_OTP_PRIMARY_CHANNEL,
  COMMS_OTP_FALLBACK_CHANNELS,
  COMMS_OTP_FALLBACK_TIMEOUT_SECONDS,
  COMMS_OTP_MANUAL_FALLBACK_AFTER_SECONDS,
  COMMS_OTP_STAFF_ASSIST_ENABLED,
  COMMS_ACTIVATION_TOKEN_TTL_HOURS,
];
