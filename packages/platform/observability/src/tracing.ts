/**
 * OpenTelemetry bootstrap (ADR-0006). Import this module FIRST in an app entry point so the
 * auto-instrumentations patch http/express/pg/ioredis before they are loaded:
 *
 *   import './tracing';          // calls startTracing(config.otel)
 *   import { NestFactory } ...
 *
 * Standalone by design: this file must not import pino or Nest.
 */
import { diag, DiagConsoleLogger, DiagLogLevel } from '@opentelemetry/api';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from '@opentelemetry/semantic-conventions';

export interface TracingOptions {
  readonly enabled: boolean;
  readonly serviceName: string;
  readonly endpoint: string;
  readonly serviceVersion?: string;
  readonly diagnostics?: boolean;
}

let sdk: NodeSDK | undefined;

/** Starts the SDK once; returns false when disabled. Safe to call in tests (disabled → no-op). */
export function startTracing(options: TracingOptions): boolean {
  if (!options.enabled || sdk) return Boolean(sdk);
  if (options.diagnostics) diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.INFO);

  sdk = new NodeSDK({
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: options.serviceName,
      ...(options.serviceVersion ? { [ATTR_SERVICE_VERSION]: options.serviceVersion } : {}),
    }),
    traceExporter: new OTLPTraceExporter({ url: `${options.endpoint}/v1/traces` }),
    metricReader: new PeriodicExportingMetricReader({
      exporter: new OTLPMetricExporter({ url: `${options.endpoint}/v1/metrics` }),
    }),
    instrumentations: [
      getNodeAutoInstrumentations({
        // Noise and overlap: we inject trace ids into pino ourselves; fs spans are useless here.
        '@opentelemetry/instrumentation-fs': { enabled: false },
        '@opentelemetry/instrumentation-pino': { enabled: false },
        '@opentelemetry/instrumentation-dns': { enabled: false },
        '@opentelemetry/instrumentation-net': { enabled: false },
      }),
    ],
  });
  sdk.start();
  const shutdown = (): void => {
    void stopTracing();
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
  return true;
}

export async function stopTracing(): Promise<void> {
  if (!sdk) return;
  const s = sdk;
  sdk = undefined;
  await s.shutdown().catch(() => undefined);
}
