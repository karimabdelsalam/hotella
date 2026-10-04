import { Inject, Injectable } from '@nestjs/common';
import { asc, eq, sql } from 'drizzle-orm';
import {
  DATABASE,
  type Database,
  executor,
  type TenantScope,
  tenantWhere,
} from '@hotella/platform-database';
import { profileObservations, type ProfileObservationRow } from './schema';

/** Interface profile coverage per instance (guide §7.3, BUILD_PLAN 10.8): field ids and counts, never values. */
@Injectable()
export class ProfileRepositories {
  constructor(@Inject(DATABASE) private readonly db: Database) {}
  private get x() {
    return executor(this.db);
  }

  /** Counts one received record: +1 received, +1 per field id carried, +1 missing mandatory when it lacked one. */
  async observe(input: {
    tenantId: string;
    propertyId: string;
    instanceId: string;
    profileCode: string;
    profileVersion: number;
    record: string;
    fields: readonly string[];
    missingMandatory: boolean;
  }): Promise<void> {
    const fields = Object.fromEntries([...new Set(input.fields)].map((f) => [f, 1]));
    const t = profileObservations;
    await this.x
      .insert(t)
      .values({
        tenantId: input.tenantId,
        propertyId: input.propertyId,
        instanceId: input.instanceId,
        profileCode: input.profileCode,
        profileVersion: input.profileVersion,
        record: input.record,
        received: 1,
        fields,
        missingMandatory: input.missingMandatory ? 1 : 0,
      })
      .onConflictDoUpdate({
        target: [t.instanceId, t.profileCode, t.record],
        set: {
          received: sql`${t.received} + 1`,
          // Adds the new message's field counts to the stored ones, key by key.
          fields: sql`(
            select coalesce(jsonb_object_agg(k, coalesce((${t.fields} ->> k)::int, 0)
                     + coalesce((excluded.fields ->> k)::int, 0)), '{}'::jsonb)
            from jsonb_object_keys(${t.fields} || excluded.fields) as k)`,
          missingMandatory: sql`${t.missingMandatory} + excluded.missing_mandatory`,
          profileVersion: sql`excluded.profile_version`,
          lastSeenAt: sql`now()`,
          updatedAt: sql`now()`,
        },
      });
  }

  forInstance(scope: TenantScope, instanceId: string): Promise<ProfileObservationRow[]> {
    return this.x
      .select()
      .from(profileObservations)
      .where(
        tenantWhere(profileObservations, scope, eq(profileObservations.instanceId, instanceId)),
      )
      .orderBy(asc(profileObservations.record));
  }

  /** Starts the coverage again (after the hotel's IFC8 configuration changed). */
  async reset(scope: TenantScope, instanceId: string): Promise<number> {
    const rows = await this.x
      .delete(profileObservations)
      .where(
        tenantWhere(profileObservations, scope, eq(profileObservations.instanceId, instanceId)),
      )
      .returning({ id: profileObservations.id });
    return rows.length;
  }
}
