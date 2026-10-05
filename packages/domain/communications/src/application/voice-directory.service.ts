import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { z } from 'zod';
import { ORGANIZATION_API, type OrganizationPublicApi } from '@hotella/domain-organization/public';
import { AuditWriter } from '@hotella/platform-audit';
import { ActionGate } from '@hotella/platform-auth';
import { isUuid, newId, type PropertyScope, TransactionRunner } from '@hotella/platform-database';
import { AppError } from '@hotella/platform-i18n';
import { CallRepositories } from '../infrastructure/call-repositories';
import { CommsRepositories } from '../infrastructure/repositories';
import type { ChannelRow, VoiceExtensionRow } from '../infrastructure/schema';

const extension = z.string().regex(/^[0-9*#]{1,16}$/);

export const voiceDirectorySchema = z.object({
  entries: z
    .array(
      z.discriminatedUnion('kind', [
        z.object({ extension, kind: z.literal('ROOM'), roomId: z.uuid() }),
        z.object({ extension, kind: z.enum(['PUBLIC', 'STAFF', 'OPERATOR']) }),
      ]),
    )
    .max(5000),
});
export const roomsByNumberSchema = z.object({
  prefix: z
    .string()
    .regex(/^\d{0,6}$/)
    .default(''),
});

/**
 * The extension directory of a voice channel (ADR-0025, Q27), kept by staff with `channel.manage`. It decides which
 * calls may get room context, so every change is audited; prefilling from room numbers is an explicit action.
 */
@Injectable()
export class VoiceDirectoryService {
  constructor(
    private readonly comms: CommsRepositories,
    private readonly calls: CallRepositories,
    @Inject(ORGANIZATION_API) private readonly org: OrganizationPublicApi,
    private readonly gate: ActionGate,
    private readonly tx: TransactionRunner,
    private readonly audit: AuditWriter,
  ) {}

  list(scope: PropertyScope, channelId: string) {
    return this.act(scope, 'read', async () => {
      const channel = await this.channel(scope, channelId);
      return (await this.calls.extensionsOf(scope, channel.id)).map(view);
    });
  }

  replace(scope: PropertyScope, channelId: string, input: z.infer<typeof voiceDirectorySchema>) {
    return this.act(scope, 'write', async () => {
      const channel = await this.channel(scope, channelId);
      const seen = new Set<string>();
      for (const e of input.entries) {
        if (seen.has(e.extension))
          throw new AppError('comms.voice.extension_duplicate', HttpStatus.UNPROCESSABLE_ENTITY, {
            extension: e.extension,
          });
        seen.add(e.extension);
        if (
          e.kind === 'ROOM' &&
          !(await this.org.getRoom(scope.tenantId, scope.propertyId, e.roomId))
        )
          throw new AppError('comms.voice.room_not_found', HttpStatus.UNPROCESSABLE_ENTITY, {
            extension: e.extension,
          });
      }
      const before = await this.calls.extensionsOf(scope, channel.id);
      await this.calls.replaceExtensions(
        scope,
        channel.id,
        input.entries.map((e) => ({
          id: newId(),
          tenantId: scope.tenantId,
          propertyId: scope.propertyId,
          channelId: channel.id,
          extension: e.extension,
          kind: e.kind,
          roomId: e.kind === 'ROOM' ? e.roomId : null,
        })),
      );
      await this.audit.record({
        action: 'comms.voice.directory.replace',
        entityType: 'channel',
        entityId: channel.id,
        tenantId: scope.tenantId,
        propertyId: scope.propertyId,
        before: { entries: before.length, rooms: before.filter((e) => e.kind === 'ROOM').length },
        after: {
          entries: input.entries.length,
          rooms: input.entries.filter((e) => e.kind === 'ROOM').length,
        },
      });
      return (await this.calls.extensionsOf(scope, channel.id)).map(view);
    });
  }

  /** Adds a ROOM entry `<prefix><room number>` for every room that has none; existing entries stay as they are. */
  roomsByNumber(
    scope: PropertyScope,
    channelId: string,
    input: z.infer<typeof roomsByNumberSchema>,
  ) {
    return this.act(scope, 'write', async () => {
      const channel = await this.channel(scope, channelId);
      const current = await this.calls.extensionsOf(scope, channel.id);
      const taken = new Set(current.map((e) => e.extension));
      const roomsWithEntry = new Set(current.map((e) => e.roomId).filter(Boolean));
      const added: Array<{ extension: string; kind: 'ROOM'; roomId: string }> = [];
      for (const room of await this.org.listRooms(scope.tenantId, scope.propertyId)) {
        const ext = `${input.prefix}${room.roomNumber}`;
        if (roomsWithEntry.has(room.id) || taken.has(ext) || !/^[0-9*#]{1,16}$/.test(ext)) continue;
        taken.add(ext);
        added.push({ extension: ext, kind: 'ROOM', roomId: room.id });
      }
      await this.calls.replaceExtensions(scope, channel.id, [
        ...current.map((e) => ({ ...e, updatedAt: new Date() })),
        ...added.map((e) => ({
          id: newId(),
          tenantId: scope.tenantId,
          propertyId: scope.propertyId,
          channelId: channel.id,
          extension: e.extension,
          kind: e.kind,
          roomId: e.roomId,
        })),
      ]);
      await this.audit.record({
        action: 'comms.voice.directory.rooms_by_number',
        entityType: 'channel',
        entityId: channel.id,
        tenantId: scope.tenantId,
        propertyId: scope.propertyId,
        after: { added: added.length, prefix: input.prefix },
      });
      return { added: added.length };
    });
  }

  private async channel(scope: PropertyScope, id: string): Promise<ChannelRow> {
    const row = isUuid(id) ? await this.comms.channel(scope, id) : undefined;
    if (!row || row.type !== 'VOICE') throw AppError.notFound('comms.channel.not_found');
    return row;
  }

  private act<T>(scope: PropertyScope, mode: 'read' | 'write', fn: () => Promise<T>): Promise<T> {
    return this.gate.execute(
      { action: 'channel.manage', tenantId: scope.tenantId, propertyId: scope.propertyId },
      () => (mode === 'read' ? this.tx.read(fn) : this.tx.run(fn)),
    );
  }
}

function view(e: VoiceExtensionRow) {
  return { extension: e.extension, kind: e.kind, roomId: e.roomId };
}
