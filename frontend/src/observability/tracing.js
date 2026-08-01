import { diag, DiagConsoleLogger, DiagLogLevel } from '@opentelemetry/api';
import { ZoneContextManager } from '@opentelemetry/context-zone';
import { registerInstrumentations } from '@opentelemetry/instrumentation';
import { DocumentLoadInstrumentation } from '@opentelemetry/instrumentation-document-load';
import { FetchInstrumentation } from '@opentelemetry/instrumentation-fetch';
import {
  XMLHttpRequestInstrumentation
} from '@opentelemetry/instrumentation-xml-http-request';
import {
  OTLPTraceExporter
} from '@opentelemetry/exporter-trace-otlp-http';
import {
  BatchSpanProcessor,
  WebTracerProvider
} from '@opentelemetry/sdk-trace-web';
import { resourceFromAttributes } from '@opentelemetry/resources';
import {
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_NAMESPACE,
  ATTR_SERVICE_VERSION,
  ATTR_DEPLOYMENT_ENVIRONMENT_NAME
} from '@opentelemetry/semantic-conventions';

let initialized = false;

function getCollectorUrl() {
  const configured = import.meta.env.VITE_OTEL_EXPORTER_OTLP_ENDPOINT;

  if (configured) {
    return `${configured.replace(/\/+$/, '')}/v1/traces`;
  }

  return 'http://localhost:4318/v1/traces';
}

export function initializeTracing() {
  if (initialized) {
    return;
  }

  initialized = true;

  if (import.meta.env.DEV) {
    diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.WARN);
  }

  const exporter = new OTLPTraceExporter({
    url: getCollectorUrl()
  });

  const provider = new WebTracerProvider({
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: 'frontend',
      [ATTR_SERVICE_NAMESPACE]: 'rootsmarket',
      [ATTR_SERVICE_VERSION]: import.meta.env.VITE_APP_VERSION || '1.0.0',
      [ATTR_DEPLOYMENT_ENVIRONMENT_NAME]:
        import.meta.env.MODE || 'development'
    }),
    spanProcessors: [
      new BatchSpanProcessor(exporter, {
        maxQueueSize: 2048,
        maxExportBatchSize: 512,
        scheduledDelayMillis: 5000,
        exportTimeoutMillis: 30000
      })
    ]
  });

  provider.register({
    contextManager: new ZoneContextManager()
  });

  const backendOrigins = [
    /^http:\/\/localhost:\d+/,
    /^http:\/\/127\.0\.0\.1:\d+/,
    /rootsmarket/
  ];

  registerInstrumentations({
    tracerProvider: provider,
    instrumentations: [
      new DocumentLoadInstrumentation(),

      new FetchInstrumentation({
        propagateTraceHeaderCorsUrls: backendOrigins,
        clearTimingResources: true,
        applyCustomAttributesOnSpan(span, request, result) {
          span.setAttribute(
            'app.http.transport',
            'fetch'
          );

          if (result instanceof Response) {
            span.setAttribute(
              'http.response.status_code',
              result.status
            );
          }
        }
      }),

      new XMLHttpRequestInstrumentation({
        propagateTraceHeaderCorsUrls: backendOrigins
      })
    ]
  });
}