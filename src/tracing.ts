/**
 * OpenTelemetry bootstrap — must be imported before NestFactory.create.
 *
 * Disabled when NODE_ENV=test or OTEL_SDK_DISABLED=true.
 * When OTEL_EXPORTER_OTLP_ENDPOINT is set, traces are exported via OTLP/HTTP.
 */

import { NodeSDK } from '@opentelemetry/sdk-node';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import {
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_VERSION,
} from '@opentelemetry/semantic-conventions';

let sdk: NodeSDK | undefined;

export function startTracing(): void {
  if (process.env.NODE_ENV === 'test' || process.env.OTEL_SDK_DISABLED === 'true') {
    return;
  }

  if (sdk) return;

  const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim();
  const traceExporter = endpoint
    ? new OTLPTraceExporter({
        url: endpoint.endsWith('/v1/traces')
          ? endpoint
          : `${endpoint.replace(/\/$/, '')}/v1/traces`,
      })
    : undefined;

  sdk = new NodeSDK({
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: process.env.OTEL_SERVICE_NAME ?? 'hypertron-api',
      [ATTR_SERVICE_VERSION]: process.env.npm_package_version ?? '0.1.0',
    }),
    traceExporter,
    instrumentations: [
      getNodeAutoInstrumentations({
        '@opentelemetry/instrumentation-fs': { enabled: false },
        '@opentelemetry/instrumentation-dns': { enabled: false },
        '@opentelemetry/instrumentation-net': { enabled: false },
      }),
    ],
  });

  sdk.start();

  const shutdown = async () => {
    try {
      await sdk?.shutdown();
    } catch {
      // best-effort
    }
  };

  process.once('SIGTERM', () => {
    void shutdown();
  });
  process.once('SIGINT', () => {
    void shutdown();
  });
}

startTracing();
