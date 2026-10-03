export { IntegrationsModule } from './integrations.module';
export { IngestService } from './application/ingest.service';
export type { IngestResult } from './application/ingest.service';
export { CONNECTOR_ADAPTERS, ConnectorRegistry } from './connectors/registry';
export { SIM_PMS_MANIFEST, simPmsAdapter } from './connectors/sim-pms';
export * from './public';
export * as integrationSchema from './infrastructure/schema';
