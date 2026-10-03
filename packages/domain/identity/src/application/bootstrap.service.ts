import { Injectable } from '@nestjs/common';
import { UserCreated } from '@hotella/contracts-events';
import { newId, TransactionRunner } from '@hotella/platform-database';
import { AuditWriter } from '@hotella/platform-audit';
import { EventPublisher } from '@hotella/platform-events';
import { AppError } from '@hotella/platform-i18n';
import { hashPassword } from '../domain/passwords';
import { IdentityRepositories } from '../infrastructure/repositories';
import { AuthService } from './auth.service';

/**
 * Creates platform staff accounts outside HTTP (the first administrator of a fresh installation). Used by the
 * `iam:bootstrap-admin` CLI; there is deliberately no HTTP endpoint that can create a platform administrator.
 */
export interface PlatformStaffInput {
  email: string;
  password: string;
  givenName: string;
  familyName?: string | null;
  localePref?: string | null;
}

@Injectable()
export class IdentityBootstrapService {
  constructor(
    private readonly repo: IdentityRepositories,
    private readonly auth: AuthService,
    private readonly tx: TransactionRunner,
    private readonly events: EventPublisher,
    private readonly audit: AuditWriter,
  ) {}

  createPlatformAdmin(input: PlatformStaffInput): Promise<{ userId: string }> {
    return this.createPlatformStaff({ ...input, kind: 'ADMIN' });
  }

  /** Platform staff: administrators (PLATFORM_ADMIN role) or support engineers (SUPPORT role, grant-based access). */
  async createPlatformStaff(
    input: PlatformStaffInput & { kind: 'ADMIN' | 'SUPPORT' },
  ): Promise<{ userId: string }> {
    const isPlatformAdmin = input.kind === 'ADMIN';
    const email = input.email.trim().toLowerCase();
    await this.auth.assertPasswordPolicy(input.password, email, null);
    const passwordHash = await hashPassword(input.password);
    return this.tx.run(async () => {
      if (await this.repo.userByLogin(null, email)) throw AppError.conflict('iam.user.email_taken');
      const person = await this.repo.insertPerson({
        id: newId(),
        tenantId: null,
        givenName: input.givenName,
        familyName: input.familyName ?? null,
        email,
        localePref: input.localePref ?? null,
      });
      const user = await this.repo.insertUser({
        id: newId(),
        tenantId: null,
        personId: person.id,
        email,
        passwordHash,
        passwordChangedAt: new Date(),
        status: 'ACTIVE',
        isPlatformAdmin,
      });
      await this.events.publish(UserCreated, {
        tenantId: null,
        source: 'iam',
        aggregate: { type: 'user', id: user.id },
        payload: {
          user_id: user.id,
          tenant_id: null,
          status: 'ACTIVE',
          is_platform_admin: isPlatformAdmin,
        },
      });
      await this.audit.record({
        action: 'iam.user.create',
        entityType: 'user',
        entityId: user.id,
        tenantId: null,
        propertyId: null,
        actor: { type: 'SYSTEM', id: null },
        reason: 'bootstrap CLI',
        after: { email, isPlatformAdmin, status: 'ACTIVE' },
      });
      return { userId: user.id };
    });
  }
}
