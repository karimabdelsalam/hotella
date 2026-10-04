import { Module, type OnModuleInit } from '@nestjs/common';
import { AI_MANIFEST } from '@hotella/domain-ai/public';
import { CATALOG_MANIFEST } from '@hotella/domain-catalog/public';
import { COMMUNICATIONS_MANIFEST } from '@hotella/domain-communications/public';
import { ENGINEERING_MANIFEST } from '@hotella/domain-engineering/public';
import { GUEST_MANIFEST } from '@hotella/domain-guest/public';
import { HOUSEKEEPING_MANIFEST } from '@hotella/domain-housekeeping/public';
import { IDENTITY_MANIFEST } from '@hotella/domain-identity';
import { INSPECTION_MANIFEST } from '@hotella/domain-inspection/public';
import { INTEGRATIONS_MANIFEST } from '@hotella/domain-integrations/public';
import { KNOWLEDGE_MANIFEST } from '@hotella/domain-knowledge/public';
import { LICENSING_MANIFEST } from '@hotella/domain-licensing/public';
import { LOGBOOK_MANIFEST } from '@hotella/domain-logbook/public';
import { LOSTFOUND_MANIFEST } from '@hotella/domain-lostfound/public';
import { OPERATIONS_MANIFEST } from '@hotella/domain-operations/public';
import { ORGANIZATION_MANIFEST } from '@hotella/domain-organization/public';
import { RELATIONS_MANIFEST } from '@hotella/domain-relations/public';
import { AUDIT_MANIFEST } from '@hotella/platform-audit';
import { ManifestRegistry, PLATFORM_MANIFEST } from '@hotella/platform-manifest';

/**
 * The worker composes route-free modules, which do not register manifests; the action gate still needs them — the
 * entitlement stage reads which module owns a permission (Spec §60), and AI tools run here as AI_AGENT. Registers
 * every module's manifest (the same set the API registers), so both processes gate identically and validate alike.
 */
@Module({})
export class WorkerManifestsModule implements OnModuleInit {
  constructor(private readonly manifests: ManifestRegistry) {}
  onModuleInit(): void {
    for (const m of [
      PLATFORM_MANIFEST,
      AUDIT_MANIFEST,
      ORGANIZATION_MANIFEST,
      IDENTITY_MANIFEST,
      INTEGRATIONS_MANIFEST,
      GUEST_MANIFEST,
      OPERATIONS_MANIFEST,
      COMMUNICATIONS_MANIFEST,
      CATALOG_MANIFEST,
      AI_MANIFEST,
      KNOWLEDGE_MANIFEST,
      HOUSEKEEPING_MANIFEST,
      ENGINEERING_MANIFEST,
      INSPECTION_MANIFEST,
      RELATIONS_MANIFEST,
      LOSTFOUND_MANIFEST,
      LOGBOOK_MANIFEST,
      LICENSING_MANIFEST,
    ])
      if (!this.manifests.get(m.code)) this.manifests.register(m);
  }
}
