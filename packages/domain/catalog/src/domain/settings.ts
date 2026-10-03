import { z } from 'zod';
import { defineSetting } from '@hotella/platform-settings';

/** Settings owned by the catalog context (BUILD_PLAN §9.3); registered by CatalogModule. */
const SCOPES = ['PLATFORM', 'TENANT', 'PROPERTY'] as const;

/** Request statuses the guest is told about (Spec §25). */
export const CATALOG_NOTIFY_STATUSES = defineSetting<
  Array<'IN_PROGRESS' | 'COMPLETED' | 'CANCELLED'>
>({
  key: 'catalog.notify.statuses',
  scopes: SCOPES,
  schema: z.array(z.enum(['IN_PROGRESS', 'COMPLETED', 'CANCELLED'])).max(3),
  default: ['IN_PROGRESS', 'COMPLETED', 'CANCELLED'],
  descriptionKey: 'catalog.setting.notify_statuses',
});

/** Duplicate window of new service versions that do not set their own (Spec §23). */
export const CATALOG_DEFAULT_DUPLICATE_WINDOW_MINUTES = defineSetting({
  key: 'catalog.request.default_duplicate_window_minutes',
  scopes: SCOPES,
  schema: z.number().int().min(0).max(1440),
  default: 30,
  descriptionKey: 'catalog.setting.default_duplicate_window_minutes',
});

export const CATALOG_SETTINGS = [CATALOG_NOTIFY_STATUSES, CATALOG_DEFAULT_DUPLICATE_WINDOW_MINUTES];
