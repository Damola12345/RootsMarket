'use strict';

/**
 * NOTE: './tracing' is deliberately NOT re-exported here.
 *
 * tracing.js calls startTracing() at module load. If the barrel pulls it in,
 * then any service doing
 *
 *   const express = require('express');
 *   const { logger } = require('@rootsmarket/observability');
 *
 * starts the SDK *after* express/amqplib/pg/redis are already in the require
 * cache. Auto-instrumentation patches modules at require time and cannot patch
 * one that is already loaded, so those libraries end up uninstrumented — no
 * HTTP spans, no pg spans, and propagation.inject() writing nothing. The
 * failure is silent and looks exactly like a propagation bug.
 *
 * Load it out-of-band instead:
 *
 *   node --require @rootsmarket/observability/tracing index.js
 */

module.exports = {
  logger: require('./logger'),
  httpMetrics: require('./http-metrics'),
  rabbitmqTracing: require('./rabbitmq-tracing'),
  traceContext: require('./trace-context'),
  suppress: require('./suppress')
};