import { z } from 'zod';
import { defineSetting } from '@hotella/platform-settings';

/** Guest relations settings (BUILD_PLAN 9.B); registered by RelationsModule. */
const SCOPES = ['PLATFORM', 'TENANT', 'PROPERTY'] as const;

/** Recovery from this amount (minor units of the property's currency) is a HIGH-risk approval. */
export const RECOVERY_HIGH_FROM_MINOR = defineSetting({
  key: 'relations.recovery.high_risk_from_minor',
  scopes: SCOPES,
  schema: z.number().int().min(0),
  default: 50_000,
  descriptionKey: 'relations.setting.recovery_high_risk_from',
});

export const RELATIONS_SETTINGS = [RECOVERY_HIGH_FROM_MINOR];
