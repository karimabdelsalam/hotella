import { describe, expect, it } from 'vitest';
import { AUDIT_MANIFEST } from '@hotella/platform-audit';
import { AI_MANIFEST } from '@hotella/domain-ai/public';
import { CATALOG_MANIFEST } from '@hotella/domain-catalog/public';
import { COMMUNICATIONS_MANIFEST } from '@hotella/domain-communications/public';
import { GUEST_MANIFEST } from '@hotella/domain-guest/public';
import { IDENTITY_MANIFEST, SYSTEM_ROLES } from '@hotella/domain-identity';
import { INTEGRATIONS_MANIFEST } from '@hotella/domain-integrations/public';
import { ENGINEERING_MANIFEST } from '@hotella/domain-engineering/public';
import { HOUSEKEEPING_MANIFEST } from '@hotella/domain-housekeeping/public';
import { INSPECTION_MANIFEST } from '@hotella/domain-inspection/public';
import { KNOWLEDGE_MANIFEST } from '@hotella/domain-knowledge/public';
import { OPERATIONS_MANIFEST } from '@hotella/domain-operations/public';
import { LOGBOOK_MANIFEST } from '@hotella/domain-logbook/public';
import { CAPABILITIES, LICENSING_MANIFEST } from '@hotella/domain-licensing/public';
import { CONNECTOR_ADAPTERS } from '@hotella/domain-integrations';
import { LOSTFOUND_MANIFEST } from '@hotella/domain-lostfound/public';
import { RESTAURANT_MANIFEST } from '@hotella/domain-restaurant/public';
import { RELATIONS_MANIFEST } from '@hotella/domain-relations/public';
import { ORGANIZATION_MANIFEST } from '@hotella/domain-organization/public';
import { PLATFORM_MANIFEST } from '@hotella/platform-manifest';

/**
 * The system roles may only grant permissions some module declares (Spec §84.19). Checked here, where every context
 * is composed, because contexts that build on identity cannot be imported by the identity package itself.
 */
const MANIFESTS = [
  ORGANIZATION_MANIFEST,
  IDENTITY_MANIFEST,
  AUDIT_MANIFEST,
  PLATFORM_MANIFEST,
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
  RESTAURANT_MANIFEST,
  LOGBOOK_MANIFEST,
  LICENSING_MANIFEST,
];

describe('system role catalog', () => {
  it('grants only permissions declared by a module manifest', () => {
    const declared = new Set(MANIFESTS.flatMap((m) => m.permissions.map((p) => p.code)));
    for (const role of SYSTEM_ROLES)
      for (const p of role.permissions) expect(declared, `${role.code}: ${p}`).toContain(p);
  });
});

/** Every entitlement code a module or connector checks exists in the licensing catalog (Spec §59, BUILD_PLAN 11.B). */
describe('entitlement codes', () => {
  const catalog = new Set(CAPABILITIES.map((c) => c.code));
  it('are all sold in the catalog', () => {
    for (const m of MANIFESTS) {
      for (const e of m.entitlements) expect(catalog, `${m.code}: ${e}`).toContain(e);
      if (m.entitlement) expect(m.entitlements, m.code).toContain(m.entitlement);
    }
    for (const a of CONNECTOR_ADAPTERS)
      if (a.manifest.entitlement)
        expect(catalog, a.manifest.code).toContain(a.manifest.entitlement);
  });
});
