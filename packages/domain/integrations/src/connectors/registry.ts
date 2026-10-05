import { z } from 'zod';
import type { ConnectorAdapter, ConnectorManifest } from '@hotella/contracts-connectors';
import { lockStandardAdapter, wifiStandardAdapter } from './access';
import { bmsStandardAdapter } from './bms';
import { opera5DbAdapter, opera5FiasAdapter, opera5OwsAdapter } from './opera5';
import { simPmsAdapter } from './sim-pms';

/**
 * Platform-side connector adapters (Spec §56). Adding a connector means adding an adapter here (Phase 10: OPERA 5
 * FIAS from 10.2, OWS from 10.3); core domains never change because they only see canonical events.
 */
export const CONNECTOR_ADAPTERS: readonly ConnectorAdapter[] = [
  simPmsAdapter,
  opera5FiasAdapter,
  opera5OwsAdapter,
  opera5DbAdapter,
  bmsStandardAdapter,
  lockStandardAdapter,
  wifiStandardAdapter,
];

export class ConnectorRegistry {
  private readonly byCode = new Map<string, ConnectorAdapter>();

  constructor(adapters: readonly ConnectorAdapter[] = CONNECTOR_ADAPTERS) {
    for (const a of adapters) {
      if (this.byCode.has(a.manifest.code))
        throw new Error(`Connector ${a.manifest.code} registered twice`);
      this.byCode.set(a.manifest.code, a);
    }
  }

  get(code: string): ConnectorAdapter | undefined {
    return this.byCode.get(code);
  }
  manifests(): ConnectorManifest[] {
    return [...this.byCode.values()].map((a) => a.manifest);
  }
}

/** Serializable catalog row for a manifest (zod schemas exported as JSON Schema for UIs and the agent). */
export function catalogRow(m: ConnectorManifest) {
  return {
    code: m.code,
    version: m.version,
    category: m.category,
    description: m.description,
    capabilities: [...m.capabilities],
    messageTypes: m.messageTypes.map((t) => ({ ...t })),
    commands: m.commands.map((c) => ({
      code: c.code,
      description: c.description,
      requires: c.requires,
      payloadSchema: z.toJSONSchema(c.payload),
    })),
    queries: (m.queries ?? []).map((q) => ({
      code: q.code,
      description: q.description,
      requires: q.requires,
      paramsSchema: z.toJSONSchema(q.params),
    })),
    configSchema: z.toJSONSchema(m.configSchema),
    credentialSchema: z.toJSONSchema(m.credentialSchema),
  };
}
