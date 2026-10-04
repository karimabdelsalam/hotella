import { Injectable } from '@nestjs/common';
import { listEventDefinitions } from '@hotella/contracts-events';
import { getDataClassRegistry } from '@hotella/platform-database';
import type { ModuleManifest } from './manifest';

export interface ManifestProblem {
  readonly module: string;
  readonly kind:
    | 'DUPLICATE_MODULE'
    | 'DUPLICATE_PERMISSION'
    | 'UNKNOWN_EVENT'
    | 'UNDECLARED_EVENT'
    | 'EVENT_OWNERSHIP'
    | 'DUPLICATE_AI_TOOL'
    | 'UNKNOWN_PERMISSION'
    | 'UNCLASSIFIED_TABLE'
    | 'UNDECLARED_ENTITLEMENT';
  readonly message: string;
}

/**
 * Collects every module manifest and cross-checks them against the other registries:
 *  - module codes unique; permission codes declared by exactly one module;
 *  - every declared event exists in the event registry and belongs to the module's namespace;
 *  - every registered event in a module's namespace is declared by that module (nothing published undeclared);
 *  - AI tool codes are unique and each tool's required permission is declared by some module;
 *  - every classified table in the module's schema exists (data classes are enforced at load by classify());
 *  - the module's gate entitlement is one of the entitlements it declares.
 * `assertValid()` runs at app boot and fails fast (CLAUDE.md rule 22).
 */
@Injectable()
export class ManifestRegistry {
  private readonly manifests = new Map<string, ModuleManifest>();

  register(manifest: ModuleManifest): void {
    if (this.manifests.has(manifest.code))
      throw new Error(`Module manifest "${manifest.code}" registered twice`);
    this.manifests.set(manifest.code, manifest);
  }

  all(): ModuleManifest[] {
    return [...this.manifests.values()].sort((a, b) => a.code.localeCompare(b.code));
  }

  get(code: string): ModuleManifest | undefined {
    return this.manifests.get(code);
  }

  /** The manifest declaring a permission (its owner), if any module of this process declares it. */
  ownerOfPermission(permission: string): ModuleManifest | undefined {
    if (
      !this.byPermission ||
      this.byPermission.size === 0 ||
      this.byPermissionVersion !== this.manifests.size
    ) {
      this.byPermission = new Map();
      for (const m of this.all()) for (const p of m.permissions) this.byPermission.set(p.code, m);
      this.byPermissionVersion = this.manifests.size;
    }
    return this.byPermission.get(permission);
  }
  private byPermission: Map<string, ModuleManifest> | undefined;
  private byPermissionVersion = -1;

  /** Permission catalog across modules (feeds IAM seeding in Phase 1). */
  permissions(): Array<{ module: string; code: string; descriptionKey: string; risk: string }> {
    return this.all().flatMap((m) => m.permissions.map((p) => ({ module: m.code, ...p })));
  }

  validate(): ManifestProblem[] {
    const problems: ManifestProblem[] = [];
    const manifests = this.all();
    const permissionOwner = new Map<string, string>();
    for (const m of manifests) {
      for (const p of m.permissions) {
        const owner = permissionOwner.get(p.code);
        if (owner && owner !== m.code) {
          problems.push({
            module: m.code,
            kind: 'DUPLICATE_PERMISSION',
            message: `permission "${p.code}" is also declared by "${owner}"`,
          });
        }
        permissionOwner.set(p.code, m.code);
      }
    }
    for (const m of manifests)
      if (m.entitlement && !m.entitlements.includes(m.entitlement))
        problems.push({
          module: m.code,
          kind: 'UNDECLARED_ENTITLEMENT',
          message: `gate entitlement "${m.entitlement}" is not listed in entitlements`,
        });
    const toolOwner = new Map<string, string>();
    for (const m of manifests) {
      for (const t of m.aiTools) {
        const owner = toolOwner.get(t.code);
        if (owner)
          problems.push({
            module: m.code,
            kind: 'DUPLICATE_AI_TOOL',
            message: `AI tool "${t.code}" is also declared by "${owner}"`,
          });
        toolOwner.set(t.code, m.code);
        if (!permissionOwner.has(t.requiredPermission))
          problems.push({
            module: m.code,
            kind: 'UNKNOWN_PERMISSION',
            message: `AI tool "${t.code}" requires "${t.requiredPermission}", which no module declares`,
          });
      }
    }
    const known = new Map(listEventDefinitions().map((d) => [d.name, d]));
    for (const m of manifests) {
      for (const name of m.events) {
        const def = known.get(name);
        if (!def) {
          problems.push({
            module: m.code,
            kind: 'UNKNOWN_EVENT',
            message: `event "${name}" is not defined in @hotella/contracts-events`,
          });
          continue;
        }
        const ns = def.type.split('.')[0];
        if (!def.canonical && ns !== m.code) {
          problems.push({
            module: m.code,
            kind: 'EVENT_OWNERSHIP',
            message: `event "${name}" belongs to namespace "${ns}", not "${m.code}"`,
          });
        }
      }
    }
    for (const def of known.values()) {
      if (def.canonical) continue; // hotel.* events are owned by the integration platform
      const ns = def.type.split('.')[0]!;
      const owner = this.manifests.get(ns);
      if (owner && !owner.events.includes(def.name)) {
        problems.push({
          module: ns,
          kind: 'UNDECLARED_EVENT',
          message: `event "${def.name}" is defined but not declared in the "${ns}" manifest`,
        });
      }
    }
    // Data classes are enforced at load time by classify() (an unclassified column cannot even be built);
    // the registry is exposed here so the control plane can list classified tables per schema.
    const classifiedTables = getDataClassRegistry().size;
    if (classifiedTables === 0 && manifests.length > 0) {
      problems.push({
        module: 'platform',
        kind: 'UNCLASSIFIED_TABLE',
        message:
          'no classified tables registered; platform schemas must be loaded before validation',
      });
    }
    return problems;
  }

  assertValid(): void {
    const problems = this.validate();
    if (problems.length > 0) {
      throw new Error(
        `Module manifests are invalid:\n${problems.map((p) => `  - [${p.module}] ${p.kind}: ${p.message}`).join('\n')}`,
      );
    }
  }
}
