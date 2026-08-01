'use strict';

const crypto = require('node:crypto');

/**
 * Express middleware recording the standard HTTP metric trio.
 *
 * Two things this fixes over the per-service copies:
 *
 * 1. Route label cardinality. `req.path` is the concrete URL — /orders/8f21…,
 *    /users/443 — so labelling with it mints a new Prometheus time series per
 *    order, user and product. That is unbounded growth in the TSDB and the
 *    usual cause of a Prometheus OOM. `req.route.path` is the template
 *    (/orders/:id) but is only populated after Express has matched a handler,
 *    so the label has to be resolved on response, not on request.
 *
 * 2. In-flight gauge leak. 'finish' does not fire when a client aborts
 *    mid-response, so inc() without a matching dec() drifts the gauge upward
 *    forever. Listening to 'close' as well, behind an idempotency guard,
 *    closes that. The guard also stops the duration histogram double-counting,
 *    since 'close' fires after 'finish' on normal responses too.
 *
 * Unmatched requests collapse to route="unmatched" rather than their raw path,
 * so a vulnerability scanner spraying random URLs cannot inflate cardinality.
 *
 * @param {{
 *   httpRequestsTotal: import('prom-client').Counter,
 *   httpRequestDuration: import('prom-client').Histogram,
 *   httpRequestsInFlight: import('prom-client').Gauge
 * }} metrics
 * @param {{ ignorePaths?: string[] }} [options]
 */
// Scrape and probe endpoints. Kept in one place so the metrics middleware, the
// request logger, and tracing.js's ignoreIncomingRequestHook cannot drift apart.
const DEFAULT_IGNORE_PATHS = [
  '/metrics',
  '/health',
  '/healthz',
  '/ready',
  '/readiness',
  '/live',
  '/liveness'
];

/**
 * Assign a request ID and log one line per request.
 *
 * Skips scrape and probe paths. Prometheus hits /metrics every scrape interval
 * and Docker hits /health on every healthcheck, so logging them produces a
 * steady stream of `request_received` lines that are pure cost in Loki and
 * drown out real traffic — and because those paths are excluded from tracing,
 * their log lines carry no usable trace ID either.
 *
 * @param {{ info: Function }} logger
 * @param {{ ignorePaths?: string[] }} [options]
 */
function createRequestContextMiddleware(logger, options = {}) {
  const ignore = new Set(options.ignorePaths || DEFAULT_IGNORE_PATHS);

  return function requestContext(req, res, next) {
    req.requestId = req.headers['x-request-id'] || crypto.randomUUID();
    res.setHeader('x-request-id', req.requestId);

    if (!ignore.has(req.path)) {
      logger.info('request_received', {
        requestId: req.requestId,
        method: req.method,
        path: req.path
      });
    }

    next();
  };
}

function createHttpMetricsMiddleware(metrics, options = {}) {
  const {
    httpRequestsTotal,
    httpRequestDuration,
    httpRequestsInFlight
  } = metrics;

  if (!httpRequestsTotal || !httpRequestDuration || !httpRequestsInFlight) {
    throw new TypeError(
      'createHttpMetricsMiddleware requires httpRequestsTotal, httpRequestDuration and httpRequestsInFlight'
    );
  }

  // Scrape and probe traffic is self-referential noise; excluded by default,
  // matching the ignoreIncomingRequestHook list in tracing.js.
  const ignore = new Set(options.ignorePaths || DEFAULT_IGNORE_PATHS);

  return function httpMetrics(req, res, next) {
    if (ignore.has(req.path)) {
      return next();
    }

    httpRequestsInFlight.inc();

    const startedAt = process.hrtime.bigint();
    let settled = false;

    const record = () => {
      if (settled) return;
      settled = true;

      httpRequestsInFlight.dec();

      const route = req.route?.path
        ? `${req.baseUrl || ''}${req.route.path}`
        : 'unmatched';

      const labels = {
        method: req.method,
        route,
        status: res.statusCode
      };

      const seconds = Number(process.hrtime.bigint() - startedAt) / 1e9;

      httpRequestDuration.observe(labels, seconds);
      httpRequestsTotal.inc(labels);
    };

    res.on('finish', record);
    res.on('close', record);

    next();
  };
}

module.exports = {
  DEFAULT_IGNORE_PATHS,
  createHttpMetricsMiddleware,
  createRequestContextMiddleware
};