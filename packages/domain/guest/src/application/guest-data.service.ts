import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { GuestAnonymized, GuestMerged } from '@hotella/contracts-events';
import {
  EXTERNAL_ENTITY,
  INTEGRATIONS_API,
  type IntegrationsPublicApi,
} from '@hotella/domain-integrations/public';
import { AuditWriter } from '@hotella/platform-audit';
import { ActionGate, ActorStore } from '@hotella/platform-auth';
import { isUuid, newId, type PropertyScope, TransactionRunner } from '@hotella/platform-database';
import { EventPublisher } from '@hotella/platform-events';
import { AppError } from '@hotella/platform-i18n';
import { GuestRepositories } from '../infrastructure/repositories';
import type { GuestRow } from '../infrastructure/schema';
import { GUEST_ENTITY, STAY_ENTITY } from './stay-projector';

const code = z
  .string()
  .trim()
  .regex(/^[a-z][a-z0-9_]{0,63}$/, 'lower_snake_case');

export const upsertPreferenceSchema = z
  .object({
    category: code,
    key: code,
    value: z.union([
      z.string().max(500),
      z.number(),
      z.boolean(),
      z.array(z.string().max(100)).max(20),
    ]),
    source: z.enum(['EXPLICIT', 'INFERRED']).default('EXPLICIT'),
    confidence: z.number().int().min(0).max(100).optional(),
    expiresAt: z.iso.datetime({ offset: true }).nullish(),
  })
  .refine((p) => p.source !== 'INFERRED' || p.confidence !== undefined, {
    message: 'INFERRED preferences need a confidence',
    path: ['confidence'],
  });
export type UpsertPreferenceInput = z.infer<typeof upsertPreferenceSchema>;

export const recordConsentSchema = z.object({
  type: z.enum([
    'SERVICE_COMMUNICATION',
    'MARKETING_WHATSAPP',
    'MARKETING_EMAIL',
    'PERSONALIZATION',
  ]),
  granted: z.boolean(),
  channel: z.enum(['FRONT_DESK', 'GUEST_WEB', 'WHATSAPP', 'EMAIL', 'PHONE', 'PMS']),
  /** How it was captured: form version, message reference, staff note. Never the guest's contact data. */
  evidence: z
    .record(z.string(), z.union([z.string().max(500), z.number(), z.boolean()]))
    .default({}),
});
export type RecordConsentInput = z.infer<typeof recordConsentSchema>;

export const mergeGuestSchema = z.object({
  intoGuestId: z.uuid(),
  reason: z.string().trim().min(5).max(1000),
});
export type MergeGuestInput = z.infer<typeof mergeGuestSchema>;

export const dataRequestSchema = z.object({
  kind: z.enum(['EXPORT', 'CORRECTION', 'ANONYMIZE', 'DELETE']),
  reason: z.string().trim().min(5).max(1000),
});
export type DataRequestInput = z.infer<typeof dataRequestSchema>;

/**
 * Guest data that staff maintain (Spec §6, §26, §69): preferences, consents, merges of duplicates and data-subject
 * requests. None of these create a guest or touch stay state (CLAUDE.md rule 19). A guest is reachable only through
 * a stay at the property in scope.
 */
@Injectable()
export class GuestDataService {
  constructor(
    private readonly repo: GuestRepositories,
    private readonly gate: ActionGate,
    private readonly tx: TransactionRunner,
    private readonly audit: AuditWriter,
    private readonly actors: ActorStore,
    private readonly events: EventPublisher,
    @Inject(INTEGRATIONS_API) private readonly integrations: IntegrationsPublicApi,
  ) {}

  // ---- preferences ----

  preferences(scope: PropertyScope, guestId: string) {
    return this.act(scope, 'guest.read', 'read', async () => {
      await this.visibleGuest(scope, guestId);
      return this.repo.preferences(scope, guestId);
    });
  }

  upsertPreference(scope: PropertyScope, guestId: string, input: UpsertPreferenceInput) {
    return this.act(scope, 'guest.manage', 'write', async () => {
      const guest = await this.visibleGuest(scope, guestId, { active: true });
      const actor = this.actor();
      const row = await this.repo.upsertPreference({
        id: newId(),
        tenantId: scope.tenantId,
        guestId: guest.id,
        category: input.category,
        key: input.key,
        value: input.value,
        source: input.source,
        confidence: input.source === 'EXPLICIT' ? 100 : input.confidence!,
        expiresAt: input.expiresAt ? new Date(input.expiresAt) : null,
        recordedByType: actor.type,
        recordedById: actor.id,
      });
      await this.audit.record({
        action: 'guest.preference.upsert',
        entityType: 'guest',
        entityId: guest.id,
        tenantId: scope.tenantId,
        propertyId: scope.propertyId,
        after: { category: row.category, key: row.key, source: row.source },
      });
      return row;
    });
  }

  deletePreference(scope: PropertyScope, guestId: string, preferenceId: string) {
    return this.act(scope, 'guest.manage', 'write', async () => {
      const guest = await this.visibleGuest(scope, guestId);
      const row = isUuid(preferenceId)
        ? await this.repo.deletePreference(scope, guest.id, preferenceId)
        : undefined;
      if (!row) throw AppError.notFound('guest.preference.not_found');
      await this.audit.record({
        action: 'guest.preference.delete',
        entityType: 'guest',
        entityId: guest.id,
        tenantId: scope.tenantId,
        propertyId: scope.propertyId,
        before: { category: row.category, key: row.key },
      });
      return { deleted: true };
    });
  }

  // ---- consents ----

  /** Current consent per type plus the full history (newest first within a type). */
  consents(scope: PropertyScope, guestId: string) {
    return this.act(scope, 'guest.read', 'read', async () => {
      await this.visibleGuest(scope, guestId);
      const history = await this.repo.consents(scope, guestId);
      const current = new Map<string, (typeof history)[number]>();
      for (const c of history) if (!current.has(c.type)) current.set(c.type, c);
      return { current: [...current.values()], history };
    });
  }

  recordConsent(scope: PropertyScope, guestId: string, input: RecordConsentInput) {
    return this.act(scope, 'guest.manage', 'write', async () => {
      const guest = await this.visibleGuest(scope, guestId, { active: true });
      const actor = this.actor();
      const row = await this.repo.insertConsent({
        id: newId(),
        tenantId: scope.tenantId,
        guestId: guest.id,
        type: input.type,
        granted: input.granted,
        channel: input.channel,
        capturedAt: new Date(),
        evidence: input.evidence,
        capturedByType: actor.type,
        capturedById: actor.id,
      });
      await this.audit.record({
        action: 'guest.consent.record',
        entityType: 'guest',
        entityId: guest.id,
        tenantId: scope.tenantId,
        propertyId: scope.propertyId,
        after: { type: row.type, granted: row.granted, channel: row.channel },
      });
      return row;
    });
  }

  // ---- merge ----

  /**
   * Merges a duplicate into a surviving guest: stays, party membership, identifiers, preferences, consents and PMS
   * profile links follow the survivor; the duplicate stays as a MERGED tombstone pointing to it (history preserved).
   */
  merge(scope: PropertyScope, guestId: string, input: MergeGuestInput) {
    return this.act(scope, 'guest.merge', 'write', async () => {
      if (guestId === input.intoGuestId)
        throw new AppError('guest.guest.merge_self', HttpStatus.UNPROCESSABLE_ENTITY);
      const source = await this.visibleGuest(scope, guestId, { active: true });
      const target = await this.visibleGuest(scope, input.intoGuestId, { active: true });
      const primaryStays = await this.repo.repointPrimary(scope, source.id, target.id);
      const party = await this.repo.repointParty(scope, source.id, target.id);
      await this.repo.moveIdentifiers(scope, source.id, target.id);
      await this.repo.movePreferences(scope, source.id, target.id);
      await this.repo.moveConsents(scope, source.id, target.id);
      const links = await this.integrations.repointReferences(
        scope.tenantId,
        GUEST_ENTITY,
        source.id,
        target.id,
      );
      await this.repo.updateGuest(scope, source.id, {
        status: 'MERGED',
        mergedIntoGuestId: target.id,
      });
      await this.events.publish(GuestMerged, {
        tenantId: scope.tenantId,
        propertyId: scope.propertyId,
        source: 'guest',
        aggregate: { type: 'guest', id: source.id },
        payload: { merged_guest_id: source.id, surviving_guest_id: target.id },
      });
      const result = { primaryStays, partyMemberships: party, externalLinks: links };
      await this.audit.record({
        action: 'guest.guest.merge',
        entityType: 'guest',
        entityId: source.id,
        tenantId: scope.tenantId,
        propertyId: scope.propertyId,
        reason: input.reason,
        after: { mergedInto: target.id, ...result },
      });
      return { mergedGuestId: source.id, survivingGuestId: target.id, moved: result };
    });
  }

  // ---- data-subject requests (Spec §69) ----

  dataRequests(scope: PropertyScope, guestId: string) {
    return this.act(scope, 'guest.data_request.manage', 'read', async () => {
      await this.visibleGuest(scope, guestId);
      return this.repo.dataRequests(scope, guestId);
    });
  }

  /**
   * EXPORT returns the guest's data once (the request keeps only its SHA-256); ANONYMIZE and DELETE anonymize
   * (deleting would destroy operational and audit integrity); CORRECTION is recorded for follow-up in the PMS,
   * which owns guest master data.
   */
  dataRequest(scope: PropertyScope, guestId: string, input: DataRequestInput) {
    return this.act(scope, 'guest.data_request.manage', 'write', async () => {
      const guest = await this.visibleGuest(scope, guestId);
      const actor = this.actor();
      const base = {
        id: newId(),
        tenantId: scope.tenantId,
        guestId: guest.id,
        kind: input.kind,
        reason: input.reason,
        requestedByType: actor.type,
        requestedById: actor.id,
      };
      if (input.kind === 'EXPORT') {
        const data = await this.exportData(scope, guest);
        const sha256 = createHash('sha256').update(JSON.stringify(data)).digest('hex');
        const row = await this.repo.insertDataRequest({
          ...base,
          status: 'COMPLETED',
          completedAt: new Date(),
          result: { sha256 },
        });
        await this.auditRequest(scope, guest.id, row.id, input, { sha256 });
        return { request: row, export: data };
      }
      if (input.kind === 'CORRECTION') {
        const row = await this.repo.insertDataRequest(base);
        await this.auditRequest(scope, guest.id, row.id, input, {});
        return { request: row };
      }
      const result = await this.anonymize(scope, guest);
      const row = await this.repo.insertDataRequest({
        ...base,
        status: 'COMPLETED',
        completedAt: new Date(),
        result,
      });
      await this.auditRequest(scope, guest.id, row.id, input, result);
      return { request: row };
    });
  }

  private async exportData(scope: PropertyScope, guest: GuestRow) {
    const stays = await this.repo.staysOfGuestAnywhere(scope, guest.id);
    return {
      guest: {
        id: guest.id,
        givenName: guest.givenName,
        familyName: guest.familyName,
        title: guest.title,
        primaryLocale: guest.primaryLocale,
        vipCode: guest.vipCode,
        status: guest.status,
      },
      identifiers: (await this.repo.identifiers(scope, guest.id)).map((i) => ({
        kind: i.kind,
        value: i.valueNormalized,
        verified: i.verifiedAt !== null,
      })),
      preferences: (await this.repo.preferences(scope, guest.id)).map((p) => ({
        category: p.category,
        key: p.key,
        value: p.value,
        source: p.source,
      })),
      consents: (await this.repo.consents(scope, guest.id)).map((c) => ({
        type: c.type,
        granted: c.granted,
        channel: c.channel,
        capturedAt: c.capturedAt,
      })),
      stays: stays.map((s) => ({
        id: s.id,
        propertyId: s.propertyId,
        status: s.status,
        expectedArrival: s.expectedArrival,
        expectedDeparture: s.expectedDeparture,
        actualCheckinAt: s.actualCheckinAt,
        actualCheckoutAt: s.actualCheckoutAt,
      })),
      exportedAt: new Date().toISOString(),
    };
  }

  /** Removes identifying data; stays, room history, work history and audit rows remain (CLAUDE.md rule 21). */
  private async anonymize(scope: PropertyScope, guest: GuestRow) {
    if (guest.status === 'ANONYMIZED') throw AppError.conflict('guest.guest.already_anonymized');
    const stays = await this.repo.staysOfGuestAnywhere(scope, guest.id);
    if (stays.some((s) => s.status === 'IN_HOUSE' || s.status === 'EXPECTED'))
      throw AppError.conflict('guest.guest.active_stay');
    await this.repo.updateGuest(scope, guest.id, {
      givenName: 'ANONYMIZED',
      familyName: null,
      title: null,
      vipCode: null,
      primaryLocale: null,
      status: 'ANONYMIZED',
      anonymizedAt: new Date(),
    });
    const identifiers = await this.repo.deleteIdentifiers(scope, guest.id);
    const preferences = await this.repo.deletePreferences(scope, guest.id);
    await this.repo.clearConsentEvidence(scope, guest.id);
    // The PMS profile no longer resolves to this guest; raw vendor messages about its stays lose their payload.
    const unlinked = await this.integrations.unlinkExternalIdentity(
      scope.tenantId,
      GUEST_ENTITY,
      guest.id,
    );
    let scrubbed = 0;
    for (const stay of stays) {
      for (const ref of await this.integrations.referencesFor(
        scope.tenantId,
        STAY_ENTITY,
        stay.id,
      )) {
        if (ref.externalEntityType !== EXTERNAL_ENTITY.RESERVATION) continue;
        scrubbed += await this.integrations.scrubRawMessages(
          scope.tenantId,
          ref.integrationInstanceId,
          [ref.externalId],
        );
      }
    }
    await this.events.publish(GuestAnonymized, {
      tenantId: scope.tenantId,
      propertyId: scope.propertyId,
      source: 'guest',
      aggregate: { type: 'guest', id: guest.id },
      payload: { guest_id: guest.id },
    });
    return {
      identifiers,
      preferences,
      unlinkedProfiles: unlinked,
      scrubbedMessages: scrubbed,
      stays: stays.length,
    };
  }

  private async auditRequest(
    scope: PropertyScope,
    guestId: string,
    requestId: string,
    input: DataRequestInput,
    result: Record<string, unknown>,
  ) {
    await this.audit.record({
      action: `guest.data_request.${input.kind.toLowerCase()}`,
      entityType: 'guest',
      entityId: guestId,
      tenantId: scope.tenantId,
      propertyId: scope.propertyId,
      reason: input.reason,
      after: { requestId, ...result },
    });
  }

  /** The guest, if it has a stay at the property in scope (otherwise 404, never a hint that it exists). */
  private async visibleGuest(
    scope: PropertyScope,
    guestId: string,
    options: { active?: boolean } = {},
  ): Promise<GuestRow> {
    const guest = isUuid(guestId) ? await this.repo.guest(scope, guestId) : undefined;
    const stays = guest ? await this.repo.staysOfGuest(scope, guest.id) : [];
    if (!guest || stays.length === 0) throw AppError.notFound('guest.guest.not_found');
    if (options.active && guest.status !== 'ACTIVE')
      throw AppError.conflict('guest.guest.not_active', { status: guest.status });
    return guest;
  }

  private actor(): { type: string; id: string | null } {
    const a = this.actors.get();
    return { type: a?.type ?? 'SYSTEM', id: a?.id ?? null };
  }

  private act<T>(
    scope: PropertyScope,
    action: string,
    mode: 'read' | 'write',
    fn: () => Promise<T>,
  ): Promise<T> {
    return this.gate.execute(
      { action, tenantId: scope.tenantId, propertyId: scope.propertyId },
      () => (mode === 'read' ? this.tx.read(fn) : this.tx.run(fn)),
    );
  }
}
