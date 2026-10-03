import { z } from 'zod';
import { uuidSchema } from '@hotella/contracts-api';
import { CONNECTOR_CAPABILITIES, MAPPING_TYPES } from '@hotella/contracts-connectors';

const secretRef = z.string().regex(/^[a-z][a-z0-9+.-]*:\/\/\S+$/, 'SecretRef such as vault://…');

export const createInstanceSchema = z.object({
  connectorCode: z.string().regex(/^[A-Z][A-Z0-9_]{1,47}$/),
  name: z.string().trim().min(1).max(200),
  config: z.record(z.string(), z.unknown()).default({}),
  credentialRefs: z.record(z.string(), secretRef).default({}),
  /** Capabilities to enable at this hotel; must be a subset of the connector's. */
  capabilities: z.array(z.enum(CONNECTOR_CAPABILITIES)).min(1).max(64),
});
export type CreateInstanceInput = z.infer<typeof createInstanceSchema>;

export const updateInstanceSchema = z.object({
  version: z.number().int().min(1),
  name: z.string().trim().min(1).max(200).optional(),
  status: z.enum(['DRAFT', 'ACTIVE', 'PAUSED', 'DISABLED']).optional(),
  config: z.record(z.string(), z.unknown()).optional(),
  credentialRefs: z.record(z.string(), secretRef).optional(),
  capabilities: z.array(z.enum(CONNECTOR_CAPABILITIES)).min(1).max(64).optional(),
});
export type UpdateInstanceInput = z.infer<typeof updateInstanceSchema>;

export const confirmMappingSchema = z.object({
  mappingType: z.enum(MAPPING_TYPES),
  externalCode: z.string().trim().min(1).max(64),
  /** ROOM → the internal room id; other types → the canonical code. */
  internalValue: z.string().trim().min(1).max(128),
  /** Required when changing an existing mapping (optimistic locking). */
  version: z.number().int().min(1).optional(),
});
export type ConfirmMappingInput = z.infer<typeof confirmMappingSchema>;

export const listMessagesQuerySchema = z.object({
  status: z
    .enum(['RECEIVED', 'PROCESSED', 'PENDING_MAPPING', 'HELD', 'FAILED', 'REJECTED'])
    .optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type ListMessagesQuery = z.infer<typeof listMessagesQuerySchema>;

export const listExceptionsQuerySchema = z.object({
  instanceId: uuidSchema.optional(),
  status: z.enum(['OPEN', 'RESOLVED', 'IGNORED']).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type ListExceptionsQuery = z.infer<typeof listExceptionsQuerySchema>;

export const closeExceptionSchema = z.object({
  version: z.number().int().min(1),
  status: z.enum(['RESOLVED', 'IGNORED']),
  resolution: z.string().trim().min(1).max(1000),
});
export type CloseExceptionInput = z.infer<typeof closeExceptionSchema>;
