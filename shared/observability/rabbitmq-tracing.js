'use strict';

const {
  context,
  propagation,
  trace,
  SpanKind,
  SpanStatusCode
} = require('@opentelemetry/api');

// One fixed instrumentation scope for the whole repo. Services are told apart
// by the service.name resource attribute set in tracing.js, not by scope —
// scope names the code doing the instrumenting, which is this package.
const tracer = trace.getTracer('@rootsmarket/rabbitmq');

function bufferToObject(content) {
  if (!Buffer.isBuffer(content)) {
    return content;
  }

  try {
    return JSON.parse(content.toString('utf8'));
  } catch {
    return {
      raw: content.toString('utf8')
    };
  }
}

function headersCarrier(headers = {}) {
  const carrier = {};

  for (const [key, value] of Object.entries(headers)) {
    if (Buffer.isBuffer(value)) {
      carrier[key] = value.toString('utf8');
    } else if (Array.isArray(value)) {
      carrier[key] = value.map(String);
    } else if (value !== undefined && value !== null) {
      carrier[key] = String(value);
    }
  }

  return carrier;
}

function injectHeaders(headers = {}) {
  const carrier = {
    ...headersCarrier(headers)
  };

  propagation.inject(context.active(), carrier);

  return {
    ...headers,
    ...carrier
  };
}

/**
 * With the default exchange ('') the exchange name carries no information —
 * the routing key IS the queue. Reporting an empty destination makes Tempo
 * attribute search useless, so fall back to the routing key.
 */
function destinationName(exchange, routingKey) {
  return exchange || routingKey || '';
}

async function publishWithTrace(channel, exchange, routingKey, payload, options = {}) {
  return tracer.startActiveSpan(
    `${exchange || 'default'} publish ${routingKey}`,
    {
      kind: SpanKind.PRODUCER,
      attributes: {
        'messaging.system': 'rabbitmq',
        'messaging.destination.name': destinationName(exchange, routingKey),
        'messaging.rabbitmq.destination.routing_key': routingKey,
        'messaging.operation.name': 'publish',
        'messaging.operation.type': 'send'
      }
    },
    async (span) => {
      try {
        const body = Buffer.isBuffer(payload)
          ? payload
          : Buffer.from(JSON.stringify(payload));

        const published = channel.publish(
          exchange,
          routingKey,
          body,
          {
            contentType: 'application/json',
            persistent: true,
            ...options,
            headers: injectHeaders(options.headers)
          }
        );

        span.setAttribute('messaging.message.body.size', body.byteLength);
        span.setStatus({
          code: SpanStatusCode.OK
        });

        return published;
      } catch (error) {
        span.recordException(error);
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: error instanceof Error ? error.message : String(error)
        });

        throw error;
      } finally {
        span.end();
      }
    }
  );
}

/**
 * Consume with automatic ack/nack.
 *
 * IMPORTANT: the handler must NOT call channel.ack() or channel.nack() itself.
 * Returning normally acks; throwing nacks (requeue controlled by
 * options.requeueOnError, default false). A handler that also acks will
 * double-ack, which amqplib treats as a channel-level protocol error and
 * closes the channel — the consumer then stops silently.
 *
 * @param {import('amqplib').Channel} channel
 * @param {string} queue
 * @param {(payload: any, message: import('amqplib').ConsumeMessage) => any} handler
 * @param {{ requeueOnError?: boolean, consume?: object }} [options]
 */
function consumeWithTrace(channel, queue, handler, options = {}) {
  return channel.consume(
    queue,
    (message) => {
      if (!message) {
        return;
      }

      const carrier = headersCarrier(message.properties?.headers);
      const parentContext = propagation.extract(context.active(), carrier);

      context.with(parentContext, () => {
        tracer.startActiveSpan(
          `${queue} process`,
          {
            kind: SpanKind.CONSUMER,
            attributes: {
              'messaging.system': 'rabbitmq',
              'messaging.destination.name': queue,
              'messaging.operation.name': 'process',
              'messaging.operation.type': 'process',
              'messaging.message.id':
                message.properties?.messageId || '',
              'messaging.rabbitmq.destination.routing_key':
                message.fields?.routingKey || ''
            }
          },
          async (span) => {
            try {
              const payload = bufferToObject(message.content);

              await handler(payload, message);

              channel.ack(message);

              span.setStatus({
                code: SpanStatusCode.OK
              });
            } catch (error) {
              span.recordException(error);
              span.setStatus({
                code: SpanStatusCode.ERROR,
                message: error instanceof Error ? error.message : String(error)
              });

              const requeue = options.requeueOnError === true;
              channel.nack(message, false, requeue);
            } finally {
              span.end();
            }
          }
        );
      });
    },
    {
      noAck: false,
      ...options.consume
    }
  );
}

module.exports = {
  publishWithTrace,
  consumeWithTrace
};