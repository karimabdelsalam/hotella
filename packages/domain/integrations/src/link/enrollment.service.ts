import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { createHash, randomBytes, X509Certificate } from 'node:crypto';
import {
  encodeEnrollmentCode,
  type EnrollRequest,
  type EnrollResponse,
} from '@hotella/contracts-connectors';
import { AuditWriter } from '@hotella/platform-audit';
import { ActionGate, ActorStore } from '@hotella/platform-auth';
import { APP_CONFIG, type AppConfig } from '@hotella/platform-config';
import {
  DATABASE,
  type Database,
  isUuid,
  newId,
  type PropertyScope,
  TransactionRunner,
  withTransaction,
} from '@hotella/platform-database';
import { AppError } from '@hotella/platform-i18n';
import { CsrRejectedError } from '@hotella/platform-pki';
import { IntegrationRepositories } from '../infrastructure/repositories';
import { LinkRepositories } from '../infrastructure/link-repositories';
import type { AgentLinkRow, IntegrationInstanceRow } from '../infrastructure/schema';
import { AgentKeys } from './agent-keys';

const TOKEN_PREFIX = 'hagt_';

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Identity URIs written into a device certificate (the certificate *is* the agent's identity). */
export function agentIdentityUris(instance: {
  id: string;
  tenantId: string;
  propertyId: string;
}): string[] {
  return [
    `urn:hotella:instance:${instance.id}`,
    `urn:hotella:tenant:${instance.tenantId}`,
    `urn:hotella:property:${instance.propertyId}`,
  ];
}

export function presentLink(link: AgentLinkRow | undefined) {
  if (!link) return { enrolled: false };
  return {
    enrolled: Boolean(link.certFingerprint) && !link.revokedAt,
    certificateSerial: link.certSerial,
    certificateNotAfter: link.certNotAfter,
    enrolledAt: link.enrolledAt,
    revokedAt: link.revokedAt,
    agentVersion: link.agentVersion,
    connected: Boolean(link.sessionId),
    lastConnectedAt: link.lastConnectedAt,
    lastDisconnectedAt: link.lastDisconnectedAt,
    lastSequenceNo: link.lastSequenceNo,
  };
}

/**
 * One-time enrollment and certificate lifecycle (ADR-0017 §2). The control plane issues a single-use, 24-hour
 * token bound to one instance; the agent sends it with a CSR for a key it generated locally; the platform signs a
 * device certificate whose identity it chooses. Revocation is immediate.
 */
@Injectable()
export class EnrollmentService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly repo: IntegrationRepositories,
    private readonly links: LinkRepositories,
    private readonly keys: AgentKeys,
    private readonly gate: ActionGate,
    private readonly tx: TransactionRunner,
    private readonly audit: AuditWriter,
    private readonly actors: ActorStore,
  ) {}

  /** Staff (control plane): a token shown exactly once to the installer. */
  createToken(scope: PropertyScope, instanceId: string) {
    return this.gate.execute(
      { action: 'integration.configure', tenantId: scope.tenantId, propertyId: scope.propertyId },
      () =>
        this.tx.run(async () => {
          const instance = await this.instance(scope, instanceId);
          if (instance.status === 'DISABLED')
            throw new AppError('integration.instance.not_active', HttpStatus.CONFLICT);
          const token = `${TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`;
          const actor = this.actors.get()?.id;
          const row = await this.links.insertToken({
            id: newId(),
            tenantId: instance.tenantId,
            propertyId: instance.propertyId,
            instanceId: instance.id,
            tokenHash: hashToken(token),
            expiresAt: new Date(Date.now() + this.config.agent.enrollmentTtlHours * 3_600_000),
            createdBy: actor && isUuid(actor) ? actor : null,
          });
          await this.audit.record({
            action: 'integration.agent.enrollment_token.create',
            entityType: 'integration_instance',
            entityId: instance.id,
            tenantId: instance.tenantId,
            propertyId: instance.propertyId,
            after: { tokenId: row.id, expiresAt: row.expiresAt },
          });
          // One value for the installer (ADR-0020): gateway, token and the CA fingerprint it must trust.
          const enrollmentCode = this.config.agent.publicUrl
            ? encodeEnrollmentCode({
                g: this.config.agent.publicUrl,
                t: token,
                c: caFingerprint((await this.keys.get()).caCertificatePem),
              })
            : null;
          return { token, enrollmentCode, expiresAt: row.expiresAt };
        }),
    );
  }

  status(scope: PropertyScope, instanceId: string) {
    return this.gate.execute(
      { action: 'integration.read', tenantId: scope.tenantId, propertyId: scope.propertyId },
      () =>
        this.tx.read(async () => {
          await this.instance(scope, instanceId);
          return presentLink(await this.links.link(scope, instanceId));
        }),
    );
  }

  /** Staff: the certificate stops working at once; the gateway closes the live session on its next check. */
  revoke(scope: PropertyScope, instanceId: string, reason: string) {
    return this.gate.execute(
      { action: 'integration.configure', tenantId: scope.tenantId, propertyId: scope.propertyId },
      () =>
        this.tx.run(async () => {
          await this.instance(scope, instanceId);
          const before = await this.links.link(scope, instanceId);
          if (!before?.certFingerprint) throw AppError.notFound('integration.agent.not_enrolled');
          const after = await this.links.updateLink(scope, instanceId, {
            revokedAt: new Date(),
            certFingerprint: null,
          });
          await this.audit.record({
            action: 'integration.agent.revoke',
            entityType: 'integration_instance',
            entityId: instanceId,
            tenantId: scope.tenantId,
            propertyId: scope.propertyId,
            reason,
            before: presentLink(before),
            after: presentLink(after),
          });
          return presentLink(after);
        }),
    );
  }

  /** Agent (gateway, no client certificate yet): token + CSR → device certificate. */
  async enroll(request: EnrollRequest): Promise<EnrollResponse> {
    const token = await this.links.tokenByHash(hashToken(request.token));
    if (!token || token.usedAt || token.expiresAt.getTime() < Date.now())
      throw new AppError('integration.agent.enrollment_invalid', HttpStatus.UNAUTHORIZED);
    const scope = { tenantId: token.tenantId };
    return withTransaction(
      this.db,
      async () => {
        const instance = await this.repo.instance(scope, token.instanceId);
        if (!instance || instance.status === 'DISABLED')
          throw new AppError('integration.agent.enrollment_invalid', HttpStatus.UNAUTHORIZED);
        if (!(await this.links.consumeToken(scope, token.id)))
          throw new AppError('integration.agent.enrollment_invalid', HttpStatus.UNAUTHORIZED);
        const issued = await this.issue(instance, request.csr, request.agent_version, 'enroll');
        const keys = await this.keys.get();
        return {
          instance_id: instance.id,
          certificate: issued.certificatePem,
          ca_certificate: keys.caCertificatePem,
          not_after: issued.notAfter.toISOString(),
          command_signing_public_key: keys.commandSigningPublicKeyPem,
          connector_code: instance.connectorCode,
          capabilities: [...instance.enabledCapabilities],
        };
      },
      { tenantId: token.tenantId },
    );
  }

  /** Agent (authenticated by its current certificate): a fresh certificate for a new key, before expiry. */
  async renew(instance: IntegrationInstanceRow, csr: string, agentVersion: string | null) {
    return withTransaction(
      this.db,
      async () => {
        const issued = await this.issue(instance, csr, agentVersion, 'renew');
        return { certificate: issued.certificatePem, not_after: issued.notAfter.toISOString() };
      },
      { tenantId: instance.tenantId },
    );
  }

  private async issue(
    instance: IntegrationInstanceRow,
    csr: string,
    agentVersion: string | null,
    kind: 'enroll' | 'renew',
  ) {
    const keys = await this.keys.get();
    let issued;
    try {
      issued = await keys.ca.issueClientCertificate(csr, {
        commonName: `instance:${instance.id}`,
        uris: agentIdentityUris(instance),
        validityDays: this.config.agent.certValidityDays,
      });
    } catch (err) {
      if (err instanceof CsrRejectedError)
        throw new AppError('integration.agent.csr_rejected', HttpStatus.BAD_REQUEST);
      throw err;
    }
    const link = await this.links.upsertLink({
      instanceId: instance.id,
      tenantId: instance.tenantId,
      propertyId: instance.propertyId,
      certFingerprint: issued.fingerprint,
      certSerial: issued.serialNumber,
      certNotAfter: issued.notAfter,
      enrolledAt: new Date(),
      revokedAt: null,
      ...(agentVersion ? { agentVersion } : {}),
    });
    await this.audit.record({
      action: `integration.agent.${kind}`,
      entityType: 'integration_instance',
      entityId: instance.id,
      tenantId: instance.tenantId,
      propertyId: instance.propertyId,
      actor: { type: 'INTEGRATION', id: instance.id },
      after: presentLink(link),
    });
    return issued;
  }

  private async instance(scope: PropertyScope, id: string): Promise<IntegrationInstanceRow> {
    const row = isUuid(id) ? await this.repo.instance(scope, id) : undefined;
    if (!row || row.propertyId !== scope.propertyId)
      throw AppError.notFound('integration.instance.not_found');
    return row;
  }
}

/** SHA-256 of the certificate's DER bytes, lowercase hex (what an installing agent compares). */
export function caFingerprint(pem: string): string {
  return new X509Certificate(pem).fingerprint256.replace(/:/g, '').toLowerCase();
}
