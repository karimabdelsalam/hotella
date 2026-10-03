import { HttpStatus, Inject, Injectable, Optional } from '@nestjs/common';
import { z } from 'zod';
import {
  LostFoundItemDisposed,
  LostFoundItemRegistered,
  LostFoundItemReleased,
} from '@hotella/contracts-events';
import { GUEST_API, type GuestPublicApi } from '@hotella/domain-guest/public';
import { ORGANIZATION_API, type OrganizationPublicApi } from '@hotella/domain-organization/public';
import { AuditWriter } from '@hotella/platform-audit';
import { ActionGate, ActorStore } from '@hotella/platform-auth';
import {
  isUuid,
  newId,
  type PropertyScope,
  type TenantScope,
  TransactionRunner,
} from '@hotella/platform-database';
import { EventPublisher } from '@hotella/platform-events';
import { AppError } from '@hotella/platform-i18n';
import { SettingsReader } from '@hotella/platform-settings';
import { IMAGE_EXTENSIONS, sniffImage, StorageService } from '@hotella/platform-storage';
import {
  COLOURS,
  DISPOSAL_METHODS,
  isOpen,
  isValuable,
  ITEM_CATEGORIES,
  ITEM_STATUSES,
  type ItemStatus,
  matchScore,
  retentionUntil,
} from '../domain/items';
import { RETENTION_DAYS } from '../domain/settings';
import { LostFoundRepositories } from '../infrastructure/repositories';
import type { ItemRow, MatchRow } from '../infrastructure/schema';

export const PHOTO_MAX_BYTES = 2 * 1024 * 1024;
const MAX_PHOTOS = 6;

export const registerItemSchema = z.object({
  kind: z.enum(['FOUND', 'LOST']),
  category: z.enum(ITEM_CATEGORIES),
  colour: z.enum(COLOURS).optional(),
  brand: z.string().trim().min(1).max(60).optional(),
  description: z.string().trim().min(3).max(2000),
  locationId: z.uuid().optional(),
  placeNote: z.string().trim().max(200).optional(),
  /** Defaults to now (found) — a guest's report may say when they think it was lost. */
  occurredAt: z.iso.datetime({ offset: true }).optional(),
  storageLocation: z.string().trim().min(1).max(120).optional(),
  /** The guest whose item it is (a lost report) or who handed it in. */
  stayId: z.uuid().optional(),
});
export const listItemsSchema = z.object({
  kind: z.enum(['FOUND', 'LOST']).optional(),
  status: z
    .string()
    .transform((v) => v.split(',').filter(Boolean))
    .pipe(z.array(z.enum(ITEM_STATUSES)))
    .optional(),
  /** Only unclaimed found items whose retention date has passed. */
  due: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .optional(),
});
export const storageSchema = z.object({
  storageLocation: z.string().trim().min(1).max(120),
  version: z.number().int().min(1),
});
export const decideMatchSchema = z.object({ version: z.number().int().min(1) });
export const releaseSchema = z.object({
  version: z.number().int().min(1),
  claimantName: z.string().trim().min(2).max(160),
  /** When the claimant is a guest of a stay at this property. */
  stayId: z.uuid().optional(),
  idDocument: z.enum(['PASSPORT', 'NATIONAL_ID', 'DRIVING_LICENCE', 'ROOM_KEY_AND_PMS', 'OTHER']),
  verificationNote: z.string().trim().min(3).max(1000),
  handover: z.enum(['IN_PERSON', 'COURIER', 'REPRESENTATIVE']).default('IN_PERSON'),
});
export const disposeSchema = z.object({
  version: z.number().int().min(1),
  method: z.enum(DISPOSAL_METHODS),
  note: z.string().trim().min(3).max(1000),
});

/**
 * Lost & Found items (Spec §13): found items and lost reports, matched by deterministic rules (a person confirms),
 * released only against a claim record, and disposed of only after their retention date by an explicit action.
 */
@Injectable()
export class ItemService {
  constructor(
    private readonly repo: LostFoundRepositories,
    private readonly tx: TransactionRunner,
    private readonly gate: ActionGate,
    private readonly audit: AuditWriter,
    private readonly events: EventPublisher,
    private readonly actors: ActorStore,
    private readonly settings: SettingsReader,
    @Inject(ORGANIZATION_API) private readonly org: OrganizationPublicApi,
    @Inject(GUEST_API) private readonly guests: GuestPublicApi,
    @Optional() private readonly storage?: StorageService,
  ) {}

  register(scope: PropertyScope, input: z.infer<typeof registerItemSchema>) {
    // Anyone who finds something may hand it in; recording a guest's loss is the desk's job.
    const action = input.kind === 'FOUND' ? 'lostfound.register' : 'lostfound.manage';
    return this.act(scope, action, async () => {
      let guestId: string | null = null;
      let locationId = input.locationId ?? null;
      if (input.stayId) {
        const stay = await this.guests.getStay(scope.tenantId, input.stayId);
        if (!stay || stay.propertyId !== scope.propertyId)
          throw AppError.notFound('guest.stay.not_found');
        guestId = stay.primaryGuestId;
        // A guest's loss is most likely in their room.
        if (!locationId && input.kind === 'LOST') locationId = stay.currentRoomId;
      }
      if (
        input.locationId &&
        !(await this.org.getLocation(scope.tenantId, scope.propertyId, input.locationId))
      )
        throw AppError.notFound('org.location.not_found');
      const actor = this.actors.require();
      const occurredAt = input.occurredAt ? new Date(input.occurredAt) : new Date();
      if (occurredAt.getTime() > Date.now() + 5 * 60_000)
        throw new AppError('lostfound.item.in_future', HttpStatus.BAD_REQUEST);
      const row = await this.repo.insertItem({
        id: newId(),
        tenantId: scope.tenantId,
        propertyId: scope.propertyId,
        number: await this.repo.nextNumber(scope),
        kind: input.kind,
        category: input.category,
        colour: input.colour ?? null,
        brand: input.brand ?? null,
        description: input.description,
        locationId,
        placeNote: input.placeNote ?? null,
        occurredAt,
        guestId,
        stayId: input.stayId ?? null,
        storageLocation: input.storageLocation ?? null,
        valuable: isValuable(input.category),
        retentionUntil:
          input.kind === 'FOUND'
            ? retentionUntil(occurredAt, await this.settings.value(RETENTION_DAYS, scope))
            : null,
        reportedByType: actor.type,
        reportedById: isUuid(actor.id) ? actor.id : null,
      });
      await this.history(scope, row, 'REGISTERED', null, 'REGISTERED', null);
      await this.findMatches(scope, row);
      await this.events.publish(LostFoundItemRegistered, {
        tenantId: scope.tenantId,
        propertyId: scope.propertyId,
        source: 'lostfound',
        aggregate: { type: 'lostfound_item', id: row.id },
        payload: {
          item_id: row.id,
          number: row.number,
          kind: row.kind,
          category: row.category,
          valuable: row.valuable,
          stay_id: row.stayId,
        },
      });
      await this.audit.record({
        action: `lostfound.item.register_${row.kind.toLowerCase()}`,
        entityType: 'lostfound_item',
        entityId: row.id,
        tenantId: scope.tenantId,
        propertyId: scope.propertyId,
        after: { number: row.number, category: row.category, valuable: row.valuable },
      });
      return row;
    });
  }

  /**
   * Scores an open item against the open items of the other kind and keeps the proposals above the threshold
   * (inside the caller's transaction). Also run once AI attributes arrive.
   */
  async findMatches(scope: PropertyScope, item: ItemRow): Promise<MatchRow[]> {
    if (!isOpen(item.status as ItemStatus)) return [];
    const others = await this.repo.openCounterparts(scope, item);
    if (others.length === 0) return [];
    const ai = await this.repo.aiMetadataOf(scope, [item.id, ...others.map((o) => o.id)]);
    const side = (i: ItemRow) => {
      const meta = ai.get(i.id);
      return {
        category: i.category,
        colour: i.colour,
        brand: i.brand,
        locationId: i.locationId,
        at: i.occurredAt,
        ai: meta ? { colours: meta.colours, brand: meta.brand } : null,
      };
    };
    const created: MatchRow[] = [];
    for (const other of others) {
      const [found, lost] = item.kind === 'FOUND' ? [item, other] : [other, item];
      const m = matchScore(side(found), side(lost));
      if (!m) continue;
      const row = await this.repo.insertMatch({
        id: newId(),
        tenantId: scope.tenantId,
        propertyId: scope.propertyId,
        foundItemId: found.id,
        lostItemId: lost.id,
        score: m.score,
        reasons: [...m.reasons],
      });
      if (row) created.push(row);
    }
    return created;
  }

  list(scope: PropertyScope, query: z.infer<typeof listItemsSchema>) {
    return this.read(scope, async () => {
      const rows = await this.repo.itemsOf(scope, {
        ...(query.kind ? { kind: query.kind } : {}),
        ...(query.status ? { statuses: query.status } : {}),
        ...(query.due
          ? {
              kind: 'FOUND' as const,
              statuses: ['REGISTERED', 'MATCHED'] as const,
              retentionDueBy: new Date().toISOString().slice(0, 10),
            }
          : {}),
      });
      const rooms = await this.roomNumbers(scope);
      return rows.map((r) => this.view(r, rooms));
    });
  }

  /** Proposed matches of the property with both items, best first. */
  matches(scope: PropertyScope) {
    return this.read(scope, async () => {
      const rows = await this.repo.proposedMatches(scope);
      const byId = new Map(
        (
          await this.repo.itemsByIds(scope, [
            ...new Set(rows.flatMap((m) => [m.foundItemId, m.lostItemId])),
          ])
        ).map((i) => [i.id, i]),
      );
      const rooms = await this.roomNumbers(scope);
      return rows.map((m) => ({
        ...m,
        found: this.view(byId.get(m.foundItemId)!, rooms),
        lost: this.view(byId.get(m.lostItemId)!, rooms),
      }));
    });
  }

  get(scope: PropertyScope, id: string) {
    return this.read(scope, async () => {
      const item = await this.find(scope, id);
      const rooms = await this.roomNumbers(scope);
      const matchRows = await this.repo.matchesOf(scope, item.id);
      const others = new Map(
        (
          await this.repo.itemsByIds(
            scope,
            matchRows.map((m) => (m.foundItemId === item.id ? m.lostItemId : m.foundItemId)),
          )
        ).map((i) => [i.id, i]),
      );
      const ai = (await this.repo.aiMetadataOf(scope, [item.id])).get(item.id);
      return {
        ...this.view(item, rooms),
        ai: ai
          ? {
              objectType: ai.objectType,
              colours: ai.colours,
              brand: ai.brand,
              keywords: ai.keywords,
            }
          : null,
        matches: matchRows.map((m) => {
          const other = others.get(m.foundItemId === item.id ? m.lostItemId : m.foundItemId)!;
          return { ...m, other: this.view(other, rooms) };
        }),
        claim: (await this.repo.claimOf(scope, item.id)) ?? null,
        history: await this.repo.historyOf(scope, item.id),
      };
    });
  }

  moveStorage(scope: PropertyScope, id: string, input: z.infer<typeof storageSchema>) {
    return this.act(scope, 'lostfound.manage', async () => {
      const item = await this.locked(scope, id, input.version);
      if (item.kind !== 'FOUND' || !isOpen(item.status as ItemStatus))
        throw AppError.conflict('lostfound.item.closed');
      const row = await this.repo.updateItem(scope, item.id, {
        storageLocation: input.storageLocation,
      });
      await this.history(scope, row, 'STORED', null, null, input.storageLocation);
      return row;
    });
  }

  confirmMatch(scope: PropertyScope, matchId: string, input: z.infer<typeof decideMatchSchema>) {
    return this.act(scope, 'lostfound.manage', async () => {
      const match = await this.proposal(scope, matchId, input.version);
      const found = await this.locked(scope, match.foundItemId);
      const lost = await this.locked(scope, match.lostItemId);
      if (found.status !== 'REGISTERED' || lost.status !== 'REGISTERED')
        throw AppError.conflict('lostfound.match.item_taken');
      const by = this.decider();
      const row = await this.repo.decideMatch(scope, match.id, {
        status: 'CONFIRMED',
        ...by,
        decidedAt: new Date(),
      });
      await this.repo.rejectOtherProposals(scope, match.id, [found.id, lost.id], by);
      for (const item of [found, lost]) {
        const moved = await this.repo.updateItem(scope, item.id, { status: 'MATCHED' });
        await this.history(scope, moved, 'MATCHED', 'REGISTERED', 'MATCHED', null);
      }
      await this.audit.record({
        action: 'lostfound.match.confirm',
        entityType: 'lostfound_match',
        entityId: match.id,
        tenantId: scope.tenantId,
        propertyId: scope.propertyId,
        after: { found: found.number, lost: lost.number, score: match.score },
      });
      return row;
    });
  }

  rejectMatch(scope: PropertyScope, matchId: string, input: z.infer<typeof decideMatchSchema>) {
    return this.act(scope, 'lostfound.manage', async () => {
      const match = await this.proposal(scope, matchId, input.version);
      const row = await this.repo.decideMatch(scope, match.id, {
        status: 'REJECTED',
        ...this.decider(),
        decidedAt: new Date(),
      });
      await this.audit.record({
        action: 'lostfound.match.reject',
        entityType: 'lostfound_match',
        entityId: match.id,
        tenantId: scope.tenantId,
        propertyId: scope.propertyId,
      });
      return row;
    });
  }

  /** Hands a found item over against a claim record (who, how verified, who released it). */
  release(scope: PropertyScope, id: string, input: z.infer<typeof releaseSchema>) {
    return this.act(scope, 'lostfound.release', async () => {
      const item = await this.locked(scope, id, input.version);
      if (item.kind !== 'FOUND') throw AppError.conflict('lostfound.item.not_found_item');
      if (!isOpen(item.status as ItemStatus)) throw AppError.conflict('lostfound.item.closed');
      let claimantGuestId: string | null = null;
      if (input.stayId) {
        const stay = await this.guests.getStay(scope.tenantId, input.stayId);
        if (!stay || stay.propertyId !== scope.propertyId)
          throw AppError.notFound('guest.stay.not_found');
        claimantGuestId = stay.primaryGuestId;
      }
      const actor = this.actors.require();
      const now = new Date();
      const claim = await this.repo.insertClaim({
        id: newId(),
        tenantId: scope.tenantId,
        propertyId: scope.propertyId,
        itemId: item.id,
        claimantGuestId,
        claimantName: input.claimantName,
        idDocument: input.idDocument,
        verificationNote: input.verificationNote,
        handover: input.handover,
        releasedById: isUuid(actor.id) ? actor.id : null,
        releasedAt: now,
      });
      const released = await this.repo.updateItem(scope, item.id, {
        status: 'RELEASED',
        closedAt: now,
      });
      await this.history(scope, released, 'RELEASED', item.status as ItemStatus, 'RELEASED', null);
      // The guest's matching lost report is settled with it.
      const confirmed = (await this.repo.matchesOf(scope, item.id)).find(
        (m) => m.status === 'CONFIRMED',
      );
      if (confirmed) {
        const lost = await this.locked(scope, confirmed.lostItemId);
        if (isOpen(lost.status as ItemStatus)) {
          const claimed = await this.repo.updateItem(scope, lost.id, {
            status: 'CLAIMED',
            closedAt: now,
          });
          await this.history(scope, claimed, 'CLAIMED', lost.status as ItemStatus, 'CLAIMED', null);
        }
      }
      await this.events.publish(LostFoundItemReleased, {
        tenantId: scope.tenantId,
        propertyId: scope.propertyId,
        source: 'lostfound',
        aggregate: { type: 'lostfound_item', id: item.id },
        payload: {
          item_id: item.id,
          category: item.category,
          lost_item_id: confirmed?.lostItemId ?? null,
          handover: input.handover,
          held_days: Math.max(
            0,
            Math.floor((now.getTime() - item.occurredAt.getTime()) / 86_400_000),
          ),
        },
      });
      await this.audit.record({
        action: 'lostfound.item.release',
        entityType: 'lostfound_item',
        entityId: item.id,
        tenantId: scope.tenantId,
        propertyId: scope.propertyId,
        after: { number: item.number, idDocument: input.idDocument, handover: input.handover },
        reason: input.verificationNote,
      });
      return { item: released, claim };
    });
  }

  /** Disposal is explicit and only once the retention date has passed (Spec §13: never silently). */
  dispose(scope: PropertyScope, id: string, input: z.infer<typeof disposeSchema>) {
    return this.act(scope, 'lostfound.manage', async () => {
      const item = await this.locked(scope, id, input.version);
      if (item.kind !== 'FOUND') throw AppError.conflict('lostfound.item.not_found_item');
      if (!isOpen(item.status as ItemStatus)) throw AppError.conflict('lostfound.item.closed');
      const today = new Date().toISOString().slice(0, 10);
      if (!item.retentionUntil || item.retentionUntil > today)
        throw new AppError('lostfound.item.retention_not_reached', HttpStatus.CONFLICT, {
          date: item.retentionUntil ?? '',
        });
      const row = await this.repo.updateItem(scope, item.id, {
        status: 'DISPOSED',
        disposalMethod: input.method,
        closedAt: new Date(),
      });
      await this.history(scope, row, 'DISPOSED', item.status as ItemStatus, 'DISPOSED', input.note);
      await this.events.publish(LostFoundItemDisposed, {
        tenantId: scope.tenantId,
        propertyId: scope.propertyId,
        source: 'lostfound',
        aggregate: { type: 'lostfound_item', id: item.id },
        payload: { item_id: item.id, category: item.category, method: input.method },
      });
      await this.audit.record({
        action: 'lostfound.item.dispose',
        entityType: 'lostfound_item',
        entityId: item.id,
        tenantId: scope.tenantId,
        propertyId: scope.propertyId,
        after: { number: item.number, method: input.method },
        reason: input.note,
      });
      return row;
    });
  }

  // ---- photos ----

  async addPhoto(scope: PropertyScope, id: string, bytes: Buffer) {
    const type = sniffImage(bytes);
    if (!type) throw new AppError('lostfound.photo.unsupported', HttpStatus.UNSUPPORTED_MEDIA_TYPE);
    if (bytes.length > PHOTO_MAX_BYTES)
      throw new AppError('lostfound.photo.too_large', HttpStatus.PAYLOAD_TOO_LARGE);
    const storage = this.storage;
    if (!storage) throw new AppError('platform.not_ready', HttpStatus.SERVICE_UNAVAILABLE);
    return this.act(scope, 'lostfound.register', async () => {
      const item = await this.locked(scope, id);
      if (!isOpen(item.status as ItemStatus)) throw AppError.conflict('lostfound.item.closed');
      if (item.photoKeys.length >= MAX_PHOTOS)
        throw new AppError('lostfound.photo.too_many', HttpStatus.CONFLICT, { max: MAX_PHOTOS });
      const name = `${newId()}.${IMAGE_EXTENSIONS[type]}`;
      await storage.put({ key: this.photoKey(item, name), body: bytes, contentType: type });
      const row = await this.repo.updateItem(scope, item.id, {
        photoKeys: [...item.photoKeys, name],
      });
      await this.history(scope, row, 'PHOTO', null, null, null);
      return { name, version: row.version };
    });
  }

  photo(scope: PropertyScope, id: string, name: string) {
    return this.gate.execute(
      { action: 'lostfound.read', tenantId: scope.tenantId, propertyId: scope.propertyId },
      async () => {
        const item = await this.tx.read(() => this.find(scope, id));
        if (!item.photoKeys.includes(name) || !this.storage)
          throw AppError.notFound('lostfound.photo.not_found');
        const body = await this.storage.getBuffer(this.photoKey(item, name)).catch(() => null);
        const type = body ? sniffImage(body) : null;
        if (!body || !type) throw AppError.notFound('lostfound.photo.not_found');
        return { body, type };
      },
    );
  }

  // ---- helpers ----

  async find(scope: TenantScope & { propertyId: string }, id: string): Promise<ItemRow> {
    const row = isUuid(id) ? await this.repo.item(scope, id) : undefined;
    if (!row || row.propertyId !== scope.propertyId)
      throw AppError.notFound('lostfound.item.not_found');
    return row;
  }

  private async locked(scope: PropertyScope, id: string, version?: number): Promise<ItemRow> {
    const row = isUuid(id) ? await this.repo.itemForUpdate(scope, id) : undefined;
    if (!row || row.propertyId !== scope.propertyId)
      throw AppError.notFound('lostfound.item.not_found');
    if (version !== undefined && row.version !== version)
      throw AppError.conflict('lostfound.item.version_conflict');
    return row;
  }

  private async proposal(scope: PropertyScope, id: string, version: number): Promise<MatchRow> {
    const row = isUuid(id) ? await this.repo.matchForUpdate(scope, id) : undefined;
    if (!row || row.propertyId !== scope.propertyId)
      throw AppError.notFound('lostfound.match.not_found');
    if (row.version !== version) throw AppError.conflict('lostfound.match.version_conflict');
    if (row.status !== 'PROPOSED') throw AppError.conflict('lostfound.match.already_decided');
    return row;
  }

  private decider() {
    const actor = this.actors.require();
    return { decidedByType: actor.type, decidedById: isUuid(actor.id) ? actor.id : null };
  }

  private async history(
    scope: TenantScope,
    item: ItemRow,
    event: string,
    from: ItemStatus | null,
    to: ItemStatus | null,
    note: string | null,
  ) {
    const actor = this.actors.get();
    await this.repo.insertHistory({
      id: newId(),
      tenantId: scope.tenantId,
      itemId: item.id,
      event,
      fromStatus: from,
      toStatus: to,
      note,
      actorType: actor?.type ?? 'SYSTEM',
      actorId: actor && isUuid(actor.id) ? actor.id : null,
    });
  }

  private photoKey(item: ItemRow, name: string) {
    return `lostfound/${item.tenantId}/${item.id}/${name}`;
  }

  private async roomNumbers(scope: PropertyScope) {
    return new Map(
      (await this.org.listRooms(scope.tenantId, scope.propertyId)).map((r) => [r.id, r.roomNumber]),
    );
  }

  /** What staff screens see: the item, where it was (room number) and, for found items, whether it is due. */
  private view(item: ItemRow, rooms: Map<string, string>) {
    const today = new Date().toISOString().slice(0, 10);
    return {
      ...item,
      roomNumber: item.locationId ? (rooms.get(item.locationId) ?? null) : null,
      retentionDue:
        item.kind === 'FOUND' &&
        isOpen(item.status as ItemStatus) &&
        !!item.retentionUntil &&
        item.retentionUntil <= today,
    };
  }

  private act<T>(scope: PropertyScope, action: string, fn: () => Promise<T>): Promise<T> {
    return this.gate.execute(
      { action, tenantId: scope.tenantId, propertyId: scope.propertyId },
      () => this.tx.run(fn),
    );
  }

  private read<T>(scope: PropertyScope, fn: () => Promise<T>): Promise<T> {
    return this.gate.execute(
      { action: 'lostfound.read', tenantId: scope.tenantId, propertyId: scope.propertyId },
      () => this.tx.read(fn),
    );
  }
}
