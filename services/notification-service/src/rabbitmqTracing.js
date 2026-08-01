/**
 * RabbitMQ <-> OpenTelemetry context propagation helpers.
 *
 * Producers wrap sendToQueue in a PRODUCER span and inject `traceparent` /
 * `tracestate` / `baggage` into the AMQP headers. Consumers extract those
 * headers back into a parent context and open a CONSUMER span beneath it,
 * which is what stitches the services into a single Tempo trace.
 *
 * Consumed via the package, never copied:
 *   const { withProducerSpan } = require("@rootsmarket/observability");
 */

const {
  propagation,
  context,
  trace,
  SpanKind,
  SpanStatusCode,
} = require("@opentelemetry/api");

/**
 * amqplib hands header values back as Buffers in some broker/driver
 * combinations. The default text-map getter would stringify those as
 * "[object Object]" and silently break extraction, so normalise here.
 */
const amqpHeaderGetter = {
  keys(carrier) {
    return carrier ? Object.keys(carrier) : [];
  },
  get(carrier, key) {
    if (!carrier) return undefined;

    const value = carrier[key];
    if (value === undefined || value === null) return undefined;

    if (Buffer.isBuffer(value)) return value.toString("utf8");
    if (Array.isArray(value)) return value.map((v) => String(v));

    return String(value);
  },
};

/**
 * Inject the currently active trace context into an AMQP headers object.
 */
function injectTraceHeaders(headers = {}) {
  propagation.inject(context.active(), headers);
  return headers;
}

/**
 * Rebuild a parent context from AMQP headers received on a message.
 */
function extractContextFromHeaders(headers = {}) {
  return propagation.extract(context.active(), headers, amqpHeaderGetter);
}

/**
 * Run a publish inside a PRODUCER span and hand the callback the headers
 * carrying the propagated context.
 *
 * @param {import("@opentelemetry/api").Tracer} tracer
 * @param {string} queue          destination queue name
 * @param {(headers: object) => any} fn  performs the actual sendToQueue
 * @param {object} [attributes]   extra span attributes
 */
async function withProducerSpan(tracer, queue, fn, attributes = {}) {
  const span = tracer.startSpan(`rabbitmq publish ${queue}`, {
    kind: SpanKind.PRODUCER,
    attributes: {
      "messaging.system": "rabbitmq",
      "messaging.operation.type": "publish",
      "messaging.destination.name": queue,
      ...attributes,
    },
  });

  const ctx = trace.setSpan(context.active(), span);

  try {
    return await context.with(ctx, () => {
      const headers = injectTraceHeaders({});
      return fn(headers);
    });
  } catch (err) {
    span.recordException(err);
    span.setStatus({
      code: SpanStatusCode.ERROR,
      message: err.message || String(err),
    });
    throw err;
  } finally {
    span.end();
  }
}

/**
 * Run a consumer handler inside a CONSUMER span parented by the trace context
 * that travelled with the message.
 *
 * @param {import("@opentelemetry/api").Tracer} tracer
 * @param {string} spanName
 * @param {object} headers        message.properties.headers
 * @param {() => any} fn          the handler body
 * @param {object} [attributes]   extra span attributes
 */
async function withConsumerSpan(tracer, spanName, headers, fn, attributes = {}) {
  const parentContext = extractContextFromHeaders(headers || {});

  const span = tracer.startSpan(
    spanName,
    {
      kind: SpanKind.CONSUMER,
      attributes: {
        "messaging.system": "rabbitmq",
        "messaging.operation.type": "process",
        ...attributes,
      },
    },
    parentContext
  );

  const ctx = trace.setSpan(parentContext, span);

  try {
    return await context.with(ctx, fn);
  } catch (err) {
    span.recordException(err);
    span.setStatus({
      code: SpanStatusCode.ERROR,
      message: err.message || String(err),
    });
    throw err;
  } finally {
    span.end();
  }
}

module.exports = {
  injectTraceHeaders,
  extractContextFromHeaders,
  withProducerSpan,
  withConsumerSpan,
};