import { Global, Module, type OnModuleInit } from '@nestjs/common';
import { defineManifest, ManifestRegistry } from '@hotella/platform-manifest';
import { AuditController } from './audit.controller';
import { AuditWriter } from './audit-writer';

export const AUDIT_MANIFEST = defineManifest({
  code: 'audit',
  schema: 'audit',
  description: 'Append-only audit trail of important mutations and security events.',
  permissions: [{ code: 'audit.read', descriptionKey: 'audit.permission.read', risk: 'READ' }],
  localeNamespaces: ['audit'],
});

/** The audit writer alone (no HTTP routes): what background processes such as the worker need. */
@Global()
@Module({ providers: [AuditWriter], exports: [AuditWriter] })
export class AuditCoreModule {}

/** Writer + `GET /audit` + manifest, for the API. */
@Module({ imports: [AuditCoreModule], controllers: [AuditController] })
export class AuditModule implements OnModuleInit {
  constructor(private readonly manifests: ManifestRegistry) {}
  onModuleInit(): void {
    this.manifests.register(AUDIT_MANIFEST);
  }
}
