import { z } from 'zod';
import { defineSetting } from '@hotella/platform-settings';
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from './passwords';

/** Tenants may raise (never lower) the staff password minimum. */
export const IAM_PASSWORD_MIN_LENGTH = defineSetting({
  key: 'iam.password.min_length',
  scopes: ['PLATFORM', 'TENANT'],
  schema: z.number().int().min(PASSWORD_MIN_LENGTH).max(PASSWORD_MAX_LENGTH),
  default: PASSWORD_MIN_LENGTH,
  descriptionKey: 'iam.setting.password_min_length',
});

export const IDENTITY_SETTINGS = [IAM_PASSWORD_MIN_LENGTH];
