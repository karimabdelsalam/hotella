import { HttpStatus, Injectable } from '@nestjs/common';
import { z } from 'zod';
import { AuditWriter } from '@hotella/platform-audit';
import { ActionGate, ActorStore } from '@hotella/platform-auth';
import { isUuid, newId, type TenantScope, TransactionRunner } from '@hotella/platform-database';
import { AppError } from '@hotella/platform-i18n';
import { ITEM_KINDS, type ItemRule, ruleProblem, SEVERITIES } from '../domain/checklist';
import { InspectionRepositories } from '../infrastructure/repositories';
import type { TemplateRow, TemplateVersionRow } from '../infrastructure/schema';

const code = z.string().regex(/^[A-Z][A-Z0-9_]{1,39}$/);
const locale = z.string().regex(/^[a-z]{2}(-[A-Z]{2})?$/);
const names = z
  .array(z.object({ locale, name: z.string().trim().min(1).max(200) }))
  .min(1)
  .max(10);

const ruleSchema = z.object({
  kind: z.enum(ITEM_KINDS),
  required: z.boolean().default(true),
  expected: z.enum(['YES', 'NO']).optional(),
  scaleMax: z.number().int().optional(),
  passFrom: z.number().int().optional(),
  min: z.number().finite().optional(),
  max: z.number().finite().optional(),
  options: z.array(code).max(30).optional(),
  failOptions: z.array(code).max(30).optional(),
  failSeverity: z.enum(SEVERITIES).default('MINOR'),
});

/** A checklist version's content: sections of items, each with its rule and its labels in the hotel's languages. */
export const versionContentSchema = z.object({
  sections: z
    .array(
      z.object({
        code,
        titles: z
          .array(z.object({ locale, title: z.string().trim().min(1).max(200) }))
          .min(1)
          .max(10),
        items: z
          .array(
            z.object({
              code,
              rule: ruleSchema,
              labels: z
                .array(
                  z.object({
                    locale,
                    label: z.string().trim().min(1).max(300),
                    help: z.string().trim().max(1000).nullish(),
                    optionLabels: z.record(code, z.string().trim().min(1).max(100)).default({}),
                  }),
                )
                .min(1)
                .max(10),
            }),
          )
          .min(1)
          .max(100),
      }),
    )
    .min(1)
    .max(30),
});
export const createTemplateSchema = versionContentSchema.extend({
  code,
  scope: z.enum(['ROOM', 'AREA', 'ASSET']),
  /** The department its findings go to (e.g. HK, ENG, SEC). */
  departmentCode: z.string().regex(/^[A-Z][A-Z0-9_]{1,31}$/),
  names,
});

/**
 * Checklist templates (Spec §11): tenant-wide, written as a draft version and published once checked; a published
 * version never changes (rule 9, enforced by triggers too). A new draft starts from the content the caller sends; one
 * draft per template at a time.
 */
@Injectable()
export class TemplateService {
  constructor(
    private readonly repo: InspectionRepositories,
    private readonly tx: TransactionRunner,
    private readonly gate: ActionGate,
    private readonly audit: AuditWriter,
    private readonly actors: ActorStore,
  ) {}

  create(scope: TenantScope, input: z.infer<typeof createTemplateSchema>) {
    return this.gate.execute(
      { action: 'inspection.template.manage', tenantId: scope.tenantId },
      () =>
        this.tx.run(async () => {
          const template = await this.repo.insertTemplate({
            id: newId(),
            tenantId: scope.tenantId,
            code: input.code,
            scope: input.scope,
            departmentCode: input.departmentCode,
          });
          if (!template) throw AppError.conflict('inspection.template.code_taken');
          await this.repo.putTemplateNames(template.id, input.names);
          const draft = await this.writeDraft(scope, template, 1, input);
          await this.audit.record({
            action: 'inspection.template.create',
            entityType: 'inspection_template',
            entityId: template.id,
            tenantId: scope.tenantId,
            after: {
              code: template.code,
              scope: template.scope,
              department: template.departmentCode,
            },
          });
          return { ...template, names: input.names, draftVersionId: draft.id };
        }),
    );
  }

  /** A new draft (replacing the current one, if any) from the given content. */
  draft(scope: TenantScope, templateId: string, input: z.infer<typeof versionContentSchema>) {
    return this.gate.execute(
      { action: 'inspection.template.manage', tenantId: scope.tenantId },
      () =>
        this.tx.run(async () => {
          const template = await this.find(scope, templateId);
          const versions = await this.repo.versionsOf(scope, template.id);
          const current = versions.find((v) => v.status === 'DRAFT');
          if (current) await this.repo.deleteVersion(scope, current.id);
          const next =
            Math.max(0, ...versions.filter((v) => v !== current).map((v) => v.versionNo)) + 1;
          const draft = await this.writeDraft(scope, template, current?.versionNo ?? next, input);
          return { id: draft.id, versionNo: draft.versionNo, status: draft.status };
        }),
    );
  }

  /** Publishes a draft after checking every rule; from then on it is what new inspections run. */
  publish(scope: TenantScope, versionId: string) {
    return this.gate.execute(
      { action: 'inspection.template.manage', tenantId: scope.tenantId },
      () =>
        this.tx.run(async () => {
          const version = isUuid(versionId)
            ? await this.repo.versionForUpdate(scope, versionId)
            : undefined;
          if (!version) throw AppError.notFound('inspection.version.not_found');
          if (version.status === 'PUBLISHED')
            throw AppError.conflict('inspection.version.published');
          const items = await this.repo.itemsOf(version.id);
          if (items.length === 0) throw AppError.conflict('inspection.version.empty');
          const bad = items.find((i) => ruleProblem(i.rule));
          if (bad)
            throw new AppError('inspection.item.invalid_rule', HttpStatus.UNPROCESSABLE_ENTITY, {
              item: bad.code,
              problem: ruleProblem(bad.rule)!,
            });
          const actor = this.actors.require();
          const published = await this.repo.publish(
            scope,
            version.id,
            isUuid(actor.id) ? actor.id : null,
          );
          await this.audit.record({
            action: 'inspection.template.publish',
            entityType: 'inspection_template_version',
            entityId: version.id,
            tenantId: scope.tenantId,
            after: {
              template_id: version.templateId,
              version_no: version.versionNo,
              items: items.length,
            },
          });
          return published;
        }),
    );
  }

  /**
   * The tenant's checklists. With a property, the permission is checked there: a hotel's supervisors run the group's
   * checklists without a tenant-wide membership.
   */
  list(input: TenantScope & { propertyId?: string | null }, locale: string) {
    const scope: TenantScope = { tenantId: input.tenantId };
    const propertyId = input.propertyId ?? null;
    return this.gate.execute(
      { action: 'inspection.read', tenantId: scope.tenantId, propertyId },
      () =>
        this.tx.read(async () => {
          const rows = await this.repo.templatesOf(scope);
          const names = await this.repo.templateNames(rows.map((r) => r.id));
          const out = [];
          for (const t of rows) {
            const published = await this.repo.publishedVersion(scope, t.id);
            out.push({
              ...t,
              name: pick(names.get(t.id), locale)?.name ?? t.code,
              publishedVersionNo: published?.versionNo ?? null,
            });
          }
          return out;
        }),
    );
  }

  /** A template with every version and the content of the requested one (latest published, else the draft). */
  get(scope: TenantScope, templateId: string, locale: string, versionId?: string) {
    return this.gate.execute({ action: 'inspection.read', tenantId: scope.tenantId }, () =>
      this.tx.read(async () => {
        const template = await this.find(scope, templateId);
        const versions = await this.repo.versionsOf(scope, template.id);
        const shown =
          (versionId && versions.find((v) => v.id === versionId)) ||
          versions.find((v) => v.status === 'PUBLISHED') ||
          versions[0];
        const names = await this.repo.templateNames([template.id]);
        return {
          ...template,
          names: names.get(template.id) ?? [],
          versions: versions.map((v) => ({
            id: v.id,
            versionNo: v.versionNo,
            status: v.status,
            publishedAt: v.publishedAt,
          })),
          content: shown ? await this.content(shown, locale) : null,
        };
      }),
    );
  }

  /** The sections and items of a version, labelled in the requested language (falling back to English, then any). */
  async content(version: TemplateVersionRow, locale: string) {
    const sections = await this.repo.sectionsOf(version.id);
    const items = await this.repo.itemsOf(version.id);
    const titles = await this.repo.sectionTitles(sections.map((s) => s.id));
    const labels = await this.repo.itemLabels(items.map((i) => i.id));
    return {
      versionId: version.id,
      versionNo: version.versionNo,
      status: version.status,
      sections: sections.map((s) => ({
        id: s.id,
        code: s.code,
        title: pick(titles.get(s.id), locale)?.title ?? s.code,
        items: items
          .filter((i) => i.sectionId === s.id)
          .map((i) => {
            const l = pick(labels.get(i.id), locale);
            return {
              id: i.id,
              code: i.code,
              rule: i.rule,
              label: l?.label ?? i.code,
              help: l?.help ?? null,
              optionLabels: l?.optionLabels ?? {},
            };
          }),
      })),
    };
  }

  private async writeDraft(
    scope: TenantScope,
    template: TemplateRow,
    versionNo: number,
    input: z.infer<typeof versionContentSchema>,
  ): Promise<TemplateVersionRow> {
    const itemCodes = input.sections.flatMap((s) => s.items.map((i) => i.code));
    if (new Set(itemCodes).size !== itemCodes.length)
      throw new AppError('inspection.item.duplicate_code', HttpStatus.UNPROCESSABLE_ENTITY);
    const version = await this.repo.insertVersion({
      id: newId(),
      tenantId: scope.tenantId,
      templateId: template.id,
      versionNo,
    });
    let position = 0;
    for (const [sectionIndex, s] of input.sections.entries()) {
      const section = await this.repo.insertSection(
        {
          id: newId(),
          tenantId: scope.tenantId,
          versionId: version.id,
          code: s.code,
          position: sectionIndex,
        },
        s.titles,
      );
      for (const item of s.items)
        await this.repo.insertItem(
          {
            id: newId(),
            tenantId: scope.tenantId,
            versionId: version.id,
            sectionId: section.id,
            code: item.code,
            position: position++,
            rule: item.rule as ItemRule,
          },
          item.labels.map((l) => ({
            locale: l.locale,
            label: l.label,
            help: l.help ?? null,
            optionLabels: l.optionLabels,
          })),
        );
    }
    return version;
  }

  private async find(scope: TenantScope, id: string): Promise<TemplateRow> {
    const t = isUuid(id) ? await this.repo.template(scope, id) : undefined;
    if (!t) throw AppError.notFound('inspection.template.not_found');
    return t;
  }
}

/** The entry in the requested language, else English, else the first. */
export function pick<T extends { locale: string }>(
  list: readonly T[] | undefined,
  locale: string,
): T | undefined {
  return (
    list?.find((x) => x.locale === locale) ?? list?.find((x) => x.locale === 'en') ?? list?.[0]
  );
}
