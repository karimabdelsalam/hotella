// Must be the first import of main.ts: starts OpenTelemetry before http/express/pg/ioredis load.
import { loadConfigFromEnv } from '@hotella/platform-config';
import { startTracing } from '@hotella/platform-observability/tracing';

export const bootConfig = loadConfigFromEnv();
startTracing({
  enabled: bootConfig.otel.enabled,
  serviceName: bootConfig.otel.serviceName,
  endpoint: bootConfig.otel.endpoint,
});
