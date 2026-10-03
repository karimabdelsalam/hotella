import { z } from 'zod';
import { errorCodeSchema } from './primitives';

/** RFC 9457 Problem Details as emitted by every Hotella API error (ADR-0012). */
export const problemDetailsSchema = z.object({
  type: z.url(),
  title: z.string(),
  status: z.number().int().min(400).max(599),
  detail: z.string().optional(),
  instance: z.string(),
  code: errorCodeSchema,
  correlation_id: z.string().nullable(),
  params: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])).optional(),
  errors: z.array(z.object({ path: z.string(), message: z.string() })).optional(),
  details: z.record(z.string(), z.unknown()).optional(),
});
export type ProblemDetails = z.infer<typeof problemDetailsSchema>;

export const IDEMPOTENCY_KEY_HEADER = 'idempotency-key';
export const IDEMPOTENT_REPLAYED_HEADER = 'idempotent-replayed';
export const idempotencyKeySchema = z
  .string()
  .min(8)
  .max(128)
  .regex(/^[A-Za-z0-9._:-]+$/);
