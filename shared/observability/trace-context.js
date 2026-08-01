'use strict';

const { context, trace } = require('@opentelemetry/api');

function getTraceContext() {
  const span = trace.getSpan(context.active());

  if (!span) {
    return {
      traceId: undefined,
      spanId: undefined,
      traceFlags: undefined
    };
  }

  const spanContext = span.spanContext();

  if (!spanContext || !spanContext.traceId || !spanContext.spanId) {
    return {
      traceId: undefined,
      spanId: undefined,
      traceFlags: undefined
    };
  }

  return {
    traceId: spanContext.traceId,
    spanId: spanContext.spanId,
    traceFlags: spanContext.traceFlags
  };
}

function withTraceContext(fields = {}) {
  return {
    ...fields,
    ...getTraceContext()
  };
}

module.exports = {
  getTraceContext,
  withTraceContext
};