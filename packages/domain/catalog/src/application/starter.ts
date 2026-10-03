import { Inject, Injectable } from '@nestjs/common';
import { z } from 'zod';
import { ORGANIZATION_API, type OrganizationPublicApi } from '@hotella/domain-organization/public';
import { AuditWriter } from '@hotella/platform-audit';
import { ActionGate } from '@hotella/platform-auth';
import { newId, type PropertyScope, TransactionRunner } from '@hotella/platform-database';
import { I18nService } from '@hotella/platform-i18n';
import type { FieldDefinition } from '../domain/rules';
import { CatalogRepositories } from '../infrastructure/repositories';
import { CatalogAdminService, unprocessable } from './admin.service';
import { draftSchema } from './schemas';

/**
 * The starter catalog (Spec §7 examples): structure here, every guest-facing text in `locales/<locale>/catalog.json`
 * under `catalog.starter.*` (CLAUDE.md rule 7). Importing creates property categories and services (skipping codes the
 * property already has) and publishes version 1; hotels edit them like any other service afterwards.
 */

type Role = 'HOUSEKEEPING' | 'ENGINEERING' | 'FRONT_OFFICE';

interface StarterService {
  readonly code: string;
  readonly category: string;
  readonly department: Role;
  readonly priority?: 'LOW' | 'NORMAL' | 'HIGH' | 'URGENT';
  readonly fields: readonly FieldDefinition[];
  readonly stayStatuses?: ReadonlyArray<'EXPECTED' | 'IN_HOUSE' | 'CHECKED_OUT'>;
  readonly partyRoles?: ReadonlyArray<'PRIMARY' | 'ACCOMPANYING'>;
}

const notes: FieldDefinition = { code: 'notes', type: 'TEXT', required: false, maxLength: 300 };

export const STARTER_CATEGORIES = [
  { code: 'HOUSEKEEPING', icon: 'sparkles', sortOrder: 10 },
  { code: 'MAINTENANCE', icon: 'wrench', sortOrder: 20 },
  { code: 'FRONT_DESK', icon: 'bell', sortOrder: 30 },
  { code: 'TRANSPORT', icon: 'car', sortOrder: 40 },
] as const;

export const STARTER_SERVICES: readonly StarterService[] = [
  {
    code: 'EXTRA_TOWELS',
    category: 'HOUSEKEEPING',
    department: 'HOUSEKEEPING',
    fields: [{ code: 'quantity', type: 'NUMBER', required: true, min: 1, max: 6 }, notes],
  },
  {
    code: 'ROOM_CLEANING',
    category: 'HOUSEKEEPING',
    department: 'HOUSEKEEPING',
    fields: [
      { code: 'preferred_time', type: 'CHOICE', required: true, options: ['NOW', 'LATER_TODAY'] },
      notes,
    ],
  },
  {
    code: 'AC_PROBLEM',
    category: 'MAINTENANCE',
    department: 'ENGINEERING',
    priority: 'HIGH',
    fields: [
      {
        code: 'issue',
        type: 'CHOICE',
        required: true,
        options: ['TOO_HOT', 'TOO_COLD', 'NOISY', 'NOT_WORKING'],
      },
      notes,
    ],
  },
  {
    code: 'WIFI_HELP',
    category: 'FRONT_DESK',
    department: 'FRONT_OFFICE',
    fields: [
      {
        code: 'issue',
        type: 'CHOICE',
        required: true,
        options: ['CANNOT_CONNECT', 'SLOW', 'PASSWORD'],
      },
      notes,
    ],
  },
  {
    code: 'AIRPORT_TRANSFER',
    category: 'TRANSPORT',
    department: 'FRONT_OFFICE',
    stayStatuses: ['EXPECTED', 'IN_HOUSE'],
    fields: [
      { code: 'pickup_at', type: 'DATETIME', required: true },
      { code: 'passengers', type: 'NUMBER', required: true, min: 1, max: 8 },
      { code: 'flight', type: 'TEXT', required: false, maxLength: 20 },
    ],
  },
  {
    code: 'LATE_CHECKOUT_REQUEST',
    category: 'FRONT_DESK',
    department: 'FRONT_OFFICE',
    partyRoles: ['PRIMARY'],
    fields: [
      { code: 'until', type: 'CHOICE', required: true, options: ['H13', 'H14', 'H16', 'H18'] },
      notes,
    ],
  },
];

export const starterImportSchema = z.object({
  /** The property's department codes for each kind of work. */
  departments: z
    .object({
      HOUSEKEEPING: z
        .string()
        .regex(/^[A-Z][A-Z0-9_]{1,31}$/)
        .default('HK'),
      ENGINEERING: z
        .string()
        .regex(/^[A-Z][A-Z0-9_]{1,31}$/)
        .default('ENG'),
      FRONT_OFFICE: z
        .string()
        .regex(/^[A-Z][A-Z0-9_]{1,31}$/)
        .default('FO'),
    })
    .default({ HOUSEKEEPING: 'HK', ENGINEERING: 'ENG', FRONT_OFFICE: 'FO' }),
});
export type StarterImportInput = z.infer<typeof starterImportSchema>;

const lower = (code: string) => code.toLowerCase();

@Injectable()
export class StarterCatalogService {
  constructor(
    private readonly repo: CatalogRepositories,
    private readonly admin: CatalogAdminService,
    private readonly gate: ActionGate,
    private readonly tx: TransactionRunner,
    private readonly audit: AuditWriter,
    private readonly i18n: I18nService,
    @Inject(ORGANIZATION_API) private readonly org: OrganizationPublicApi,
  ) {}

  /** Imports what the property does not have yet; returns the codes created and skipped. */
  import(scope: PropertyScope, input: StarterImportInput) {
    return this.gate.execute(
      { action: 'catalog.manage', tenantId: scope.tenantId, propertyId: scope.propertyId },
      () =>
        this.tx.run(async () => {
          for (const code of new Set(Object.values(input.departments))) {
            const d = await this.org.getDepartment(scope.tenantId, scope.propertyId, code);
            if (!d || d.status !== 'ACTIVE')
              throw unprocessable('catalog.version.department_unknown', { department: code });
          }
          const locales = this.i18n.supportedLocales;
          const categoryIds = new Map<string, string>();
          for (const c of STARTER_CATEGORIES) {
            const existing =
              (await this.repo.categoryByCode(scope, scope.propertyId, c.code)) ??
              (await this.repo.categoryByCode(scope, null, c.code));
            if (existing) {
              categoryIds.set(c.code, existing.id);
              continue;
            }
            const row = await this.repo.insertCategory({
              id: newId(),
              tenantId: scope.tenantId,
              propertyId: scope.propertyId,
              code: c.code,
              sortOrder: c.sortOrder,
              icon: c.icon,
            });
            await this.repo.putCategoryTranslations(
              row.id,
              locales.map((locale) => ({
                locale,
                name: this.i18n.t(`catalog.starter.category.${lower(c.code)}.name`, {}, locale),
              })),
            );
            categoryIds.set(c.code, row.id);
          }
          const created: string[] = [];
          const skipped: string[] = [];
          for (const [i, s] of STARTER_SERVICES.entries()) {
            if (
              (await this.repo.definitionByCode(scope, scope.propertyId, s.code)) ||
              (await this.repo.definitionByCode(scope, null, s.code))
            ) {
              skipped.push(s.code);
              continue;
            }
            const definition = await this.repo.insertDefinition({
              id: newId(),
              tenantId: scope.tenantId,
              propertyId: scope.propertyId,
              code: s.code,
              categoryId: categoryIds.get(s.category)!,
              sortOrder: (i + 1) * 10,
            });
            const draft = draftSchema.parse({
              departmentCode: input.departments[s.department],
              priority: s.priority ?? 'NORMAL',
              requiredFields: s.fields,
              eligibility: {
                ...(s.stayStatuses ? { stayStatuses: s.stayStatuses } : {}),
                ...(s.partyRoles ? { partyRoles: s.partyRoles } : {}),
              },
              translations: locales.map((locale) => this.texts(s, locale)),
            });
            const version = await this.admin.insertDraft(scope, definition, 1, draft);
            await this.admin.markPublished(scope, definition, version.id, null);
            created.push(s.code);
          }
          await this.audit.record({
            action: 'catalog.starter.import',
            entityType: 'property',
            entityId: scope.propertyId,
            tenantId: scope.tenantId,
            propertyId: scope.propertyId,
            after: { created, skipped, departments: input.departments },
          });
          return { created, skipped };
        }),
    );
  }

  private texts(s: StarterService, locale: string) {
    const base = `catalog.starter.service.${lower(s.code)}`;
    const t = (key: string) => this.i18n.t(key, {}, locale);
    return {
      locale,
      name: t(`${base}.name`),
      shortDescription: t(`${base}.short`),
      fieldLabels: Object.fromEntries(
        s.fields.map((f) => [
          f.code,
          {
            label: t(`catalog.starter.field.${f.code}`),
            ...(f.type === 'CHOICE'
              ? {
                  options: Object.fromEntries(
                    f.options.map((o) => [o, t(`catalog.starter.option.${f.code}.${lower(o)}`)]),
                  ),
                }
              : {}),
          },
        ]),
      ),
    };
  }
}
