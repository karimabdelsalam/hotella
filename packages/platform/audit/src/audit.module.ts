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

@Global()
@Module({ controllers: [AuditController], providers: [AuditWriter], exports: [AuditWriter] })
export class AuditModule implements OnModuleInit {
  constructor(private readonly manifests: ManifestRegistry) {}
  onModuleInit(): void {
    this.manifests.register(AUDIT_MANIFEST);
  }
}
