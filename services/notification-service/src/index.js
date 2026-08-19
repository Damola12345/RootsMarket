require("dotenv").config();

const express = require("express");
const cors = require("cors");
const amqp = require("amqplib");

const { logger } = require("@rootsmarket/observability/logger");
const { shutdownTracing } = require("@rootsmarket/observability/tracing");
const { consumeWithTrace } = require("@rootsmarket/observability/rabbitmq-tracing");
const { createHttpMetricsMiddleware } = require("@rootsmarket/observability/http-metrics");

const {
  register,
  httpRequestsTotal,
  httpRequestDuration,
  httpRequestsInFlight,
  notificationsSentTotal,
  notificationsFailedTotal,
  rabbitmqMessagesConsumedTotal,
} = require("./metrics");

const app = express();

const SERVICE_NAME = "notification-service";
const PORT = process.env.PORT || 3005;
const RABBITMQ_URL = process.env.RABBITMQ_URL || "";

const PAYMENT_COMPLETED_QUEUE = "payment.completed";

const CORS_ORIGIN = process.env.CORS_ORIGIN
  ? process.env.CORS_ORIGIN.split(",").map((origin) => origin.trim())
  : true;

app.use(
  cors({
    origin: CORS_ORIGIN,
    credentials: true,
    allowedHeaders: [
      "Content-Type",
      "Authorization",
      "traceparent",
      "tracestate",
      "baggage",
      "x-request-id",
    ],
    exposedHeaders: ["traceparent", "x-request-id"],
  })
);

app.use(express.json());

app.use(
  createHttpMetricsMiddleware({
    httpRequestsTotal,
    httpRequestDuration,
    httpRequestsInFlight,
  })
);

let rabbitConnection = null;
let rabbitChannel = null;

// rabbitReady, not "is rabbitChannel truthy". After the broker restarts, the
// channel object still exists but is dead — so a truthiness check reports
// healthy while the service consumes nothing. That is a silent failure the
// whole observability stack cannot see: no error logs, no failed metric,
// green health, and messages piling up unconsumed.
let rabbitReady = false;
let rabbitRetryTimer = null;

const RABBITMQ_RETRY_MS = Number(process.env.RABBITMQ_RETRY_MS || 5000);

function scheduleRabbitReconnect() {
  if (isShuttingDown || rabbitRetryTimer) return;

  rabbitRetryTimer = setTimeout(() => {
    rabbitRetryTimer = null;

    connectRabbitMQ().catch((err) => {
      logger.warn("rabbitmq_reconnect_failed", {
        error: err.message || String(err),
        retryInMs: RABBITMQ_RETRY_MS,
      });
      scheduleRabbitReconnect();
    });
  }, RABBITMQ_RETRY_MS);
}

// Attach lifecycle handlers to a fresh connection.
//
// The 'error' listener is not optional: amqplib emits 'error' on the
// connection, and an EventEmitter with no 'error' listener throws, killing the
// process. That is what took payment-service down when the broker restarted.
function wireRabbitLifecycle() {
  rabbitConnection.on("error", (err) => {
    logger.warn("rabbitmq_connection_error", {
      error: err.message || String(err),
    });
  });

  rabbitConnection.on("close", () => {
    rabbitReady = false;
    rabbitChannel = null;

    if (isShuttingDown) return;

    logger.warn("rabbitmq_connection_closed_reconnecting", {
      retryInMs: RABBITMQ_RETRY_MS,
    });
    scheduleRabbitReconnect();
  });

  rabbitChannel.on("error", (err) => {
    logger.warn("rabbitmq_channel_error", {
      error: err.message || String(err),
    });
  });

  rabbitChannel.on("close", () => {
    rabbitReady = false;
  });
}

app.get("/health", (req, res) => {
  const rabbitHealthy = rabbitReady;

  res.status(rabbitHealthy ? 200 : 503).json({
    status: rabbitHealthy ? "healthy" : "unhealthy",
    service: SERVICE_NAME,
    dependencies: {
      rabbitmq: rabbitHealthy ? "healthy" : "unhealthy",
    },
  });
});

/**
 * consumeWithTrace owns ack/nack: returning acks, throwing nacks.
 * Do not call rabbitChannel.ack() or .nack() in here.
 */
async function handlePaymentCompleted(event) {
  rabbitmqMessagesConsumedTotal.inc({ queue: PAYMENT_COMPLETED_QUEUE });

  try {
    logger.info("payment_completed_event_received", {
      orderId: event.orderId,
      paymentId: event.paymentId,
      userId: event.userId,
      amount: event.amount,
      status: event.status,
    });

    // Your notification logic goes here.
    logger.info("notification_sent", {
      type: "payment_confirmation",
      orderId: event.orderId,
      paymentId: event.paymentId,
    });

    notificationsSentTotal.inc();
  } catch (err) {
    notificationsFailedTotal.inc();

    logger.error("notification_processing_failed", {
      orderId: event?.orderId,
      error: err,
    });

    throw err;
  }
}

async function connectRabbitMQ() {
  rabbitConnection = await amqp.connect(RABBITMQ_URL);
  rabbitChannel = await rabbitConnection.createChannel();

  wireRabbitLifecycle();

  await rabbitChannel.assertQueue(PAYMENT_COMPLETED_QUEUE, { durable: true });

  rabbitChannel.prefetch(1);

  await consumeWithTrace(
    rabbitChannel,
    PAYMENT_COMPLETED_QUEUE,
    handlePaymentCompleted
  );

  rabbitReady = true;

  logger.info("rabbitmq_consumer_started", {
    consuming: PAYMENT_COMPLETED_QUEUE,
  });
}

app.get("/metrics", async (req, res) => {
  res.set("Content-Type", register.contentType);
  res.end(await register.metrics());
});

async function start() {
  // A broker that is slow to accept connections should delay readiness, not
  // kill the process — the same reconnect path handles both cases.
  try {
    await connectRabbitMQ();
  } catch (err) {
    logger.warn("rabbitmq_initial_connect_failed", {
      error: err.message || String(err),
    });
    scheduleRabbitReconnect();
  }

  app.listen(PORT, () => {
    logger.info("service_started", {
      port: PORT,
      corsOrigins: CORS_ORIGIN === true ? "all" : CORS_ORIGIN,
    });
  });
}

let isShuttingDown = false;

async function shutdown() {
  if (isShuttingDown) return;
  isShuttingDown = true;

  logger.info("service_shutting_down");

  try {
    if (rabbitChannel) await rabbitChannel.close();
  } catch (err) {
    logger.warn("rabbitmq_channel_shutdown_failed", { error: err });
  }

  try {
    if (rabbitConnection) await rabbitConnection.close();
  } catch (err) {
    logger.warn("rabbitmq_connection_shutdown_failed", { error: err });
  }

  // Last, and awaited: flush buffered spans before the process goes away.
  // BatchSpanProcessor holds spans for up to 5s, so a consumer-only service
  // like this can lose an entire run's worth on restart without it.
  await shutdownTracing("shutdown");

  process.exit(0);
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

start().catch((err) => {
  logger.error("service_start_failed", { error: err });
  process.exit(1);
});