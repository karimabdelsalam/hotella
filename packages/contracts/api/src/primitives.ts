import { z } from 'zod';

export const uuidSchema = z.uuid();
export const localeSchema = z
  .string()
  .regex(/^[a-z]{2}(-[A-Z]{2})?$/, 'BCP 47 language tag such as en or ar-EG');
/** Stable machine-readable codes: `<domain>.<entity>.<message>` (ADR-0012). */
export const errorCodeSchema = z.string().regex(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*){1,4}$/);
export const correlationIdSchema = z.string().regex(/^[A-Za-z0-9._:-]{8,128}$/);
