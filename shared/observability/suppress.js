'use strict';

const { context } = require('@opentelemetry/api');
const { suppressTracing } = require('@opentelemetry/core');

/**
 * Run a function with tracing suppressed for everything it touches.
 *
 * Excluding a route via ignoreIncomingRequestHook only stops the *server* span.
 * Instrumented calls made inside that route — pg queries, redis commands,
 * outbound HTTP — still create spans. With no parent on the context, each one
 * becomes the root of its own orphan trace.
 *
 * That is where traces like
 *
 *   user-service: pg-pool.connect   Services 1   476ms
 *
 * come from: a /health handler running `SELECT 1` every 15 seconds, per
 * service, forever. They cost Tempo storage, drown real traces in the root-span
 * view, and describe nothing anyone wants to debug.
 *
 * suppressTracing() sets a context key that every OTel instrumentation checks
 * before creating a span, so the whole subtree is silenced rather than merely
 * detached.
 *
 *   app.get('/health', (req, res) => withoutTracing(async () => { ... }));
 */
function withoutTracing(fn) {
  return context.with(suppressTracing(context.active()), fn);
}

module.exports = { withoutTracing };