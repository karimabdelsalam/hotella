import { HttpStatus, Inject, Injectable, Optional } from '@nestjs/common';
import { z } from 'zod';
import {
  type EventEnvelope,
  InspectionCompleted,
  InspectionFindingRaised,
  WorkItemStatusChanged,
} from '@hotella/contracts-events';
import { ENGINEERING_API, type EngineeringPublicApi } from '@hotella/domain-engineering/public';
import { OPERATIONS_API, type OperationsPublicApi } from '@hotella/domain-operations/public';
import { ORGANIZATION_API, type OrganizationPublicApi } from '@hotella/domain-organization/public';
import { AuditWriter } from '@hotella/platform-audit';
import { ActionGate, ActorStore } from '@hotella/platform-auth';
import { isUuid, newId, type PropertyScope, TransactionRunner } from '@hotella/platform-database';
import { EventPublisher } from '@hotella/platform-events';
import { AppError } from '@hotella/platform-i18n';
import { IMAGE_EXTENSIONS, sniffImage, StorageService } from '@hotella/platform-storage';
import { type Answer, answerProblem, evaluate, type Severity } from '../domain/checklist';
import { InspectionRepositories } from '../infrastructure/repositories';
import type { FindingRow, InspectionRow } from '../infrastructure/schema';
import { pick, TemplateService } from './template.service';

/** The work kind of a finding's follow-up (registered with the operations engine). */
export const INSPECTION_FINDING_KIND = 'INSPECTION_FINDING';
export const PHOTO_MAX_BYTES = 2 * 1024 * 1024;
const PRIORITY: Record<Severity, 'LOW' | 'NORMAL' | 'HIGH' | 'URGENT'> = {
  INFO: 'LOW',
  MINOR: 'NORMAL',
  MAJOR: 'HIGH',
  CRITICAL: 'URGENT',
};

const answerSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('PASS_FAIL'), value: z.enum(['PASS', 'FAIL']) }),
  z.object({ kind: z.literal('YES_NO'), value: z.enum(['YES', 'NO']) }),
  z.object({ kind: z.literal('SCORE'), value: z.number() }),
  z.object({ kind: z.literal('NUMBER'), value: z.number().finite() }),
  z.object({ kind: z.literal('TEXT'), value: z.string().max(2000) }),
  z.object({ kind: z.literal('PHOTO'), value: z.array(z.string().max(200)).min(1).max(10) }),
  z.object({ kind: z.literal('MULTI_SELECT'), value: z.array(z.string().max(40)).max(30) }),
]);
export const startInspectionSchema = z
  .object({
    templateId: z.uuid(),
    locationId: z.uuid().optional(),
    assetId: z.uuid().optional(),
    source: z.enum(['STAFF', 'SCHEDULE', 'HK_JOB', 'WORK_ORDER']).default('STAFF'),
    sourceRef: z.string().max(64).optional(),
  })
  .refine((v) => v.locationId || v.assetId, { message: 'locationId or assetId' });
export const answerItemSchema = z.object({
  itemCode: z.string().max(40),
  answer: answerSchema,
  note: z.string().trim().max(2000).optional(),
});
export const listInspectionsSchema = z.object({
  status: z
    .string()
    .transform((v) => v.split(',').filter(Boolean))
    .pipe(z.array(z.enum(['IN_PROGRESS', 'COMPLETED', 'CANCELLED'])))
    .optional(),
  locationId: z.uuid().optional(),
});

/**
 * Inspections (Spec §11): started on the latest published version of a checklist at a place or on an asset, answered
 * item by item (every answer kept), completed when every required item is answered. Completion is deterministic:
 * score, result and findings come from `evaluate`; a CRITICAL finding opens URGENT work for the template's
 * department at once, other findings can be turned into work by a person.
 */
@Injectable()
export class InspectionService {
  constructor(
    private readonly repo: InspectionRepositories,
    private readonly templates: TemplateService,
    private readonly tx: TransactionRunner,
    private readonly gate: ActionGate,
    private readonly audit: AuditWriter,
    private readonly events: EventPublisher,
    private readonly actors: ActorStore,
    @Inject(ORGANIZATION_API) private readonly org: OrganizationPublicApi,
    @Inject(OPERATIONS_API) private readonly ops: OperationsPublicApi,
    @Optional() @Inject(ENGINEERING_API) private readonly engineering?: EngineeringPublicApi,
    @Optional() private readonly storage?: StorageService,
  ) {}

  start(scope: PropertyScope, input: z.infer<typeof startInspectionSchema>) {
    return this.act(scope, 'inspection.perform', async () => {
      const template = await this.repo.template(scope, input.templateId);
      if (!template || !template.active) throw AppError.notFound('inspection.template.not_found');
      const version = await this.repo.publishedVersion(scope, template.id);
      if (!version) throw AppError.conflict('inspection.template.not_published');
      let locationId = input.locationId ?? null;
      if (input.assetId) {
        const asset = await this.engineering?.getAsset(
          scope.tenantId,
          scope.propertyId,
          input.assetId,
        );
        if (!asset) throw AppError.notFound('eng.asset.not_found');
        locationId ??= asset.locationId;
      }
      if (
        !locationId ||
        !(await this.org.getLocation(scope.tenantId, scope.propertyId, locationId))
      )
        throw AppError.notFound('org.location.not_found');
      const actor = this.actors.require();
      const row = await this.repo.insertInspection({
        id: newId(),
        tenantId: scope.tenantId,
        propertyId: scope.propertyId,
        number: await this.repo.nextNumber(scope),
        templateId: template.id,
        templateVersionId: version.id,
        locationId,
        assetId: input.assetId ?? null,
        source: input.source,
        sourceRef: input.sourceRef ?? null,
        inspectorType: actor.type,
        inspectorId: isUuid(actor.id) ? actor.id : null,
        startedAt: new Date(),
      });
      await this.audit.record({
        action: 'inspection.start',
        entityType: 'inspection',
        entityId: row.id,
        tenantId: scope.tenantId,
        propertyId: scope.propertyId,
        after: { number: row.number, template: template.code, version_no: version.versionNo },
      });
      return row;
    });
  }

  answer(scope: PropertyScope, id: string, input: z.infer<typeof answerItemSchema>) {
    return this.act(scope, 'inspection.perform', async () => {
      const inspection = await this.open(scope, id);
      const item = (await this.repo.itemsOf(inspection.templateVersionId)).find(
        (i) => i.code === input.itemCode,
      );
      if (!item) throw AppError.notFound('inspection.item.not_found');
      const answer = input.answer as Answer;
      const problem = answerProblem(item.rule, answer);
      if (problem)
        throw new AppError('inspection.answer.invalid', HttpStatus.UNPROCESSABLE_ENTITY, {
          item: item.code,
          problem,
        });
      // A photo answer may only name photos uploaded to this inspection.
      if (
        answer.kind === 'PHOTO' &&
        answer.value.some((k) => !k.startsWith(this.photoPrefix(inspection)))
      )
        throw new AppError('inspection.answer.invalid', HttpStatus.UNPROCESSABLE_ENTITY, {
          item: item.code,
          problem: 'photo',
        });
      const actor = this.actors.require();
      await this.repo.insertResponse({
        id: newId(),
        tenantId: scope.tenantId,
        inspectionId: inspection.id,
        itemId: item.id,
        answer,
        note: input.note ?? null,
        answeredByType: actor.type,
        answeredById: isUuid(actor.id) ? actor.id : null,
      });
      return { itemCode: item.code, answer };
    });
  }

  /** Stores a photo for this inspection (PNG/JPEG/WebP read from the bytes, at most 2 MB); returns its key. */
  async addPhoto(scope: PropertyScope, id: string, bytes: Buffer) {
    const type = sniffImage(bytes);
    if (!type)
      throw new AppError('inspection.photo.unsupported', HttpStatus.UNSUPPORTED_MEDIA_TYPE);
    if (bytes.length > PHOTO_MAX_BYTES)
      throw new AppError('inspection.photo.too_large', HttpStatus.PAYLOAD_TOO_LARGE);
    const storage = this.storage;
    if (!storage) throw new AppError('platform.not_ready', HttpStatus.SERVICE_UNAVAILABLE);
    return this.act(scope, 'inspection.perform', async () => {
      const inspection = await this.open(scope, id);
      const key = `${this.photoPrefix(inspection)}${newId()}.${IMAGE_EXTENSIONS[type]}`;
      await storage.put({ key, body: bytes, contentType: type });
      return { key };
    });
  }

  /** A photo of an inspection, for people who may read it. */
  photo(scope: PropertyScope, id: string, name: string) {
    return this.gate.execute(
      { action: 'inspection.read', tenantId: scope.tenantId, propertyId: scope.propertyId },
      async () => {
        const inspection = await this.tx.read(() => this.find(scope, id));
        if (!/^[0-9a-f-]{36}\.(png|jpg|webp)$/.test(name) || !this.storage)
          throw AppError.notFound('inspection.photo.not_found');
        const body = await this.storage
          .getBuffer(`${this.photoPrefix(inspection)}${name}`)
          .catch(() => null);
        const type = body ? sniffImage(body) : null;
        if (!body || !type) throw AppError.notFound('inspection.photo.not_found');
        return { body, type };
      },
    );
  }

  /** Completes the inspection: deterministic score, result and findings; CRITICAL findings open URGENT work. */
  complete(scope: PropertyScope, id: string) {
    return this.act(scope, 'inspection.perform', async () => {
      const inspection = await this.open(scope, id);
      const template = (await this.repo.template(scope, inspection.templateId))!;
      const items = await this.repo.itemsOf(inspection.templateVersionId);
      const latest = await this.repo.latestResponses(scope, inspection.id);
      const byItem = new Map(latest.map((r) => [r.itemId, r.answer]));
      const evaluation = evaluate(
        items.map((i) => ({ code: i.code, rule: i.rule })),
        new Map(items.flatMap((i) => (byItem.has(i.id) ? [[i.code, byItem.get(i.id)!]] : []))),
      );
      if (evaluation.missing.length > 0)
        throw new AppError('inspection.incomplete', HttpStatus.UNPROCESSABLE_ENTITY, {
          items: evaluation.missing.join(', '),
        });
      const now = new Date();
      const done = await this.repo.updateInspection(scope, inspection.id, {
        status: 'COMPLETED',
        completedAt: now,
        score: evaluation.score,
        result: evaluation.result,
      });
      const counts = { info: 0, minor: 0, major: 0, critical: 0 };
      for (const f of evaluation.findings) {
        const item = items.find((i) => i.code === f.itemCode)!;
        counts[f.severity.toLowerCase() as keyof typeof counts]++;
        let finding = await this.repo.insertFinding({
          id: newId(),
          tenantId: scope.tenantId,
          propertyId: scope.propertyId,
          inspectionId: inspection.id,
          itemId: item.id,
          severity: f.severity,
        });
        if (f.severity === 'CRITICAL')
          finding = await this.openWork(
            scope,
            inspection,
            template.departmentCode,
            finding,
            item.code,
          );
        await this.events.publish(InspectionFindingRaised, {
          tenantId: scope.tenantId,
          propertyId: scope.propertyId,
          source: 'inspection',
          aggregate: { type: 'inspection', id: inspection.id },
          payload: {
            finding_id: finding.id,
            inspection_id: inspection.id,
            item_code: item.code,
            severity: f.severity,
            location_id: inspection.locationId,
            asset_id: inspection.assetId,
            work_item_id: finding.workItemId,
          },
        });
      }
      await this.events.publish(InspectionCompleted, {
        tenantId: scope.tenantId,
        propertyId: scope.propertyId,
        source: 'inspection',
        aggregate: { type: 'inspection', id: inspection.id },
        payload: {
          inspection_id: inspection.id,
          template_code: template.code,
          template_version_id: inspection.templateVersionId,
          location_id: inspection.locationId,
          asset_id: inspection.assetId,
          source: inspection.source,
          source_ref: inspection.sourceRef,
          score: evaluation.score,
          result: evaluation.result,
          findings: counts,
        },
      });
      await this.audit.record({
        action: 'inspection.complete',
        entityType: 'inspection',
        entityId: inspection.id,
        tenantId: scope.tenantId,
        propertyId: scope.propertyId,
        after: { score: evaluation.score, result: evaluation.result, findings: counts },
      });
      return done;
    });
  }

  cancel(scope: PropertyScope, id: string) {
    return this.act(scope, 'inspection.perform', async () => {
      const inspection = await this.open(scope, id);
      const row = await this.repo.updateInspection(scope, inspection.id, { status: 'CANCELLED' });
      await this.audit.record({
        action: 'inspection.cancel',
        entityType: 'inspection',
        entityId: inspection.id,
        tenantId: scope.tenantId,
        propertyId: scope.propertyId,
      });
      return row;
    });
  }

  /** Turns an open (non-critical) finding into work for the template's department. */
  workForFinding(scope: PropertyScope, findingId: string) {
    return this.act(scope, 'inspection.perform', async () => {
      const finding = isUuid(findingId)
        ? await this.repo.findingForUpdate(scope, findingId)
        : undefined;
      if (!finding || finding.propertyId !== scope.propertyId)
        throw AppError.notFound('inspection.finding.not_found');
      if (finding.status !== 'OPEN') throw AppError.conflict('inspection.finding.not_open');
      const inspection = (await this.repo.inspection(scope, finding.inspectionId))!;
      const template = (await this.repo.template(scope, inspection.templateId))!;
      const item = (await this.repo.itemsOf(inspection.templateVersionId)).find(
        (i) => i.id === finding.itemId,
      )!;
      return this.openWork(scope, inspection, template.departmentCode, finding, item.code);
    });
  }

  list(scope: PropertyScope, query: z.infer<typeof listInspectionsSchema>, locale: string) {
    return this.read(scope, async () => {
      const rows = await this.repo.inspectionsOf(scope, {
        ...(query.status ? { statuses: query.status } : {}),
        ...(query.locationId ? { locationId: query.locationId } : {}),
      });
      const names = await this.repo.templateNames([...new Set(rows.map((r) => r.templateId))]);
      const rooms = new Map(
        (await this.org.listRooms(scope.tenantId, scope.propertyId)).map((r) => [
          r.id,
          r.roomNumber,
        ]),
      );
      return rows.map((r) => ({
        ...r,
        templateName: pick(names.get(r.templateId), locale)?.name ?? null,
        roomNumber: rooms.get(r.locationId) ?? null,
      }));
    });
  }

  /** The inspection with its checklist (in the person's language), the latest answers and the findings. */
  get(scope: PropertyScope, id: string, locale: string) {
    return this.read(scope, async () => {
      const inspection = await this.find(scope, id);
      const version = (await this.repo.version(scope, inspection.templateVersionId))!;
      const names = await this.repo.templateNames([inspection.templateId]);
      const room = await this.org.getRoom(scope.tenantId, scope.propertyId, inspection.locationId);
      const items = await this.repo.itemsOf(version.id);
      const codeOf = new Map(items.map((i) => [i.id, i.code]));
      return {
        ...inspection,
        templateName: pick(names.get(inspection.templateId), locale)?.name ?? null,
        roomNumber: room?.roomNumber ?? null,
        checklist: await this.templates.content(version, locale),
        answers: (await this.repo.latestResponses(scope, inspection.id)).map((r) => ({
          itemCode: codeOf.get(r.itemId)!,
          answer: r.answer,
          note: r.note,
          answeredAt: r.createdAt,
        })),
        findings: (await this.repo.findingsOf(scope, inspection.id)).map((f) => ({
          ...f,
          itemCode: codeOf.get(f.itemId)!,
        })),
      };
    });
  }

  openFindings(scope: PropertyScope) {
    return this.read(scope, () => this.repo.openFindings(scope));
  }

  /** Worker consumer: the follow-up work of a finding was resolved (or cancelled), so is the finding. */
  async followWork(envelope: EventEnvelope): Promise<void> {
    if (!envelope.tenant_id) return;
    const e = WorkItemStatusChanged.parse(envelope);
    if (e.payload.kind !== INSPECTION_FINDING_KIND) return;
    if (e.payload.to !== 'RESOLVED' && e.payload.to !== 'CANCELLED') return;
    const scope = { tenantId: envelope.tenant_id };
    await this.tx.run(async () => {
      const finding = await this.repo.findingOfWorkItem(scope, e.payload.work_item_id);
      if (!finding || finding.status === 'RESOLVED') return;
      await this.repo.updateFinding(
        scope,
        finding.id,
        e.payload.to === 'RESOLVED'
          ? { status: 'RESOLVED', resolvedAt: new Date() }
          : { status: 'OPEN', workItemId: null },
      );
    });
  }

  // ---- helpers ----

  private async openWork(
    scope: PropertyScope,
    inspection: InspectionRow,
    departmentCode: string,
    finding: FindingRow,
    itemCode: string,
  ): Promise<FindingRow> {
    const department = await this.org.getDepartment(
      scope.tenantId,
      scope.propertyId,
      departmentCode,
    );
    const work = await this.ops.createWorkItem({
      tenantId: scope.tenantId,
      propertyId: scope.propertyId,
      kind: INSPECTION_FINDING_KIND,
      source: { module: 'inspection', entityType: 'inspection_finding', entityId: finding.id },
      title: {
        key: 'inspection.finding.title',
        params: { number: inspection.number, item: itemCode, severity: finding.severity },
      },
      priority: PRIORITY[finding.severity],
      locationId: inspection.locationId,
      departmentCode: department?.status === 'ACTIVE' ? departmentCode : null,
    });
    return this.repo.updateFinding(scope, finding.id, { status: 'LINKED', workItemId: work.id });
  }

  private photoPrefix(inspection: InspectionRow): string {
    return `inspection/${inspection.tenantId}/${inspection.id}/`;
  }

  private async find(scope: PropertyScope, id: string): Promise<InspectionRow> {
    const row = isUuid(id) ? await this.repo.inspection(scope, id) : undefined;
    if (!row || row.propertyId !== scope.propertyId)
      throw AppError.notFound('inspection.not_found');
    return row;
  }

  private async open(scope: PropertyScope, id: string): Promise<InspectionRow> {
    const row = isUuid(id) ? await this.repo.inspectionForUpdate(scope, id) : undefined;
    if (!row || row.propertyId !== scope.propertyId)
      throw AppError.notFound('inspection.not_found');
    if (row.status !== 'IN_PROGRESS') throw AppError.conflict('inspection.closed');
    return row;
  }

  private act<T>(scope: PropertyScope, action: string, fn: () => Promise<T>): Promise<T> {
    return this.gate.execute(
      { action, tenantId: scope.tenantId, propertyId: scope.propertyId },
      () => this.tx.run(fn),
    );
  }

  private read<T>(scope: PropertyScope, fn: () => Promise<T>): Promise<T> {
    return this.gate.execute(
      { action: 'inspection.read', tenantId: scope.tenantId, propertyId: scope.propertyId },
      () => this.tx.read(fn),
    );
  }
}
