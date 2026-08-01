'use strict';

const process = require('node:process');

const { NodeSDK } = require('@opentelemetry/sdk-node');
const { resourceFromAttributes } = require('@opentelemetry/resources');
const {
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_NAMESPACE,
  ATTR_SERVICE_VERSION,
  ATTR_DEPLOYMENT_ENVIRONMENT_NAME
} = require('@opentelemetry/semantic-conventions');
const {
  OTLPTraceExporter
} = require('@opentelemetry/exporter-trace-otlp-http');
const {
  getNodeAutoInstrumentations
} = require('@opentelemetry/auto-instrumentations-node');

let sdk = null;
let started = false;

// The in-flight shutdown promise, not a boolean. Both the signal handler here
// and the service's own shutdown() call shutdownTracing(); a boolean guard
// would make the second caller return immediately and exit the process while
// the first flush was still in flight. Sharing one promise means every caller
// awaits the same completion.
let shutdownPromise = null;

function normalizeEndpoint(endpoint) {
  const base = String(
    endpoint || 'http://otel-collector:4318'
  ).replace(/\/+$/, '');

  return base.endsWith('/v1/traces')
    ? base
    : `${base}/v1/traces`;
}

async function startTracing() {
  if (started) {
    return sdk;
  }

  const serviceName = process.env.OTEL_SERVICE_NAME;

  if (!serviceName) {
    throw new Error('OTEL_SERVICE_NAME is required');
  }

  const resource = resourceFromAttributes({
    [ATTR_SERVICE_NAME]: serviceName,
    [ATTR_SERVICE_NAMESPACE]:
      process.env.OTEL_SERVICE_NAMESPACE || 'rootsmarket',
    [ATTR_SERVICE_VERSION]:
      process.env.SERVICE_VERSION ||
      process.env.npm_package_version ||
      '1.0.0',
    [ATTR_DEPLOYMENT_ENVIRONMENT_NAME]:
      process.env.NODE_ENV || 'development'
  });

  sdk = new NodeSDK({
    resource,

    traceExporter: new OTLPTraceExporter({
      url: normalizeEndpoint(
        process.env.OTEL_EXPORTER_OTLP_ENDPOINT
      )
    }),

    instrumentations: [
      getNodeAutoInstrumentations({
        '@opentelemetry/instrumentation-fs': {
          enabled: false
        },

        // Disabled deliberately. rabbitmq-tracing.js does manual
        // inject/extract. Running both produces two PRODUCER and two CONSUMER
        // spans per message and two writers competing over the same AMQP
        // headers object. Pick one; this repo picks the manual helper.
        '@opentelemetry/instrumentation-amqplib': {
          enabled: false
        },

        '@opentelemetry/instrumentation-http': {
          enabled: true,

          ignoreIncomingRequestHook(req) {
            const url = req.url || '';

            return [
              '/health',
              '/healthz',
              '/ready',
              '/readiness',
              '/live',
              '/liveness',
              '/metrics'
            ].includes(url);
          }
        },

        '@opentelemetry/instrumentation-express': {
          enabled: true
        },

        '@opentelemetry/instrumentation-pg': {
          enabled: true,
          enhancedDatabaseReporting: false
        },

        '@opentelemetry/instrumentation-redis': {
          enabled: true
        }
      })
    ]
  });

  try {
    await sdk.start();
    started = true;

    process.stdout.write(
      `${JSON.stringify({
        timestamp: new Date().toISOString(),
        level: 'info',
        service: serviceName,
        message: 'opentelemetry_started'
      })}\n`
    );
  } catch (err) {
    process.stderr.write(
      `${JSON.stringify({
        timestamp: new Date().toISOString(),
        level: 'error',
        service: serviceName,
        message: 'opentelemetry_start_failed',
        error: err instanceof Error ? err.message : String(err)
      })}\n`
    );

    throw err;
  }

  return sdk;
}

async function flush(signal) {
  try {
    await sdk.shutdown();

    process.stdout.write(
      `${JSON.stringify({
        timestamp: new Date().toISOString(),
        level: 'info',
        service: process.env.OTEL_SERVICE_NAME,
        message: 'opentelemetry_shutdown_complete',
        signal
      })}\n`
    );
  } catch (err) {
    process.stderr.write(
      `${JSON.stringify({
        timestamp: new Date().toISOString(),
        level: 'error',
        service: process.env.OTEL_SERVICE_NAME,
        message: 'opentelemetry_shutdown_failed',
        signal,
        error: err instanceof Error ? err.message : String(err)
      })}\n`
    );
  }
}

/**
 * Flush pending spans. Safe to call repeatedly and from several places at once —
 * every caller receives the same promise and therefore the same completion.
 *
 * This deliberately does NOT exit the process. The service owns exit, and calls
 * this last in its own shutdown handler so the final batch reaches the
 * collector before the process goes away.
 */
function shutdownTracing(signal) {
  if (!sdk) return Promise.resolve();

  if (!shutdownPromise) {
    shutdownPromise = flush(signal);
  }

  return shutdownPromise;
}

// Fail loudly rather than as an unhandled rejection: a missing
// OTEL_SERVICE_NAME should stop the container, not start it untraced.
void startTracing().catch((err) => {
  process.stderr.write(
    `${JSON.stringify({
      timestamp: new Date().toISOString(),
      level: 'fatal',
      message: 'opentelemetry_bootstrap_failed',
      error: err instanceof Error ? err.message : String(err)
    })}\n`
  );

  process.exit(1);
});

// Start flushing as soon as the signal arrives, but do not exit — the service's
// own SIGTERM handler awaits shutdownTracing() and then exits. If both handlers
// called process.exit(0), whichever finished first would kill the other, and the
// app's cleanup (close channel, drain pool) is far quicker than an HTTP export,
// so the spans would lose that race every time.
process.once('SIGTERM', () => {
  void shutdownTracing('SIGTERM');
});

process.once('SIGINT', () => {
  void shutdownTracing('SIGINT');
});

module.exports = {
  startTracing,
  shutdownTracing
};