require("dotenv").config();

const express = require("express");
const cors = require("cors");
const { Pool } = require("pg");
const amqp = require("amqplib");

const { logger } = require("@rootsmarket/observability/logger");
const { withoutTracing } = require("@rootsmarket/observability/suppress");
const { shutdownTracing } = require("@rootsmarket/observability/tracing");
const {
  publishWithTrace,
  consumeWithTrace,
} = require("@rootsmarket/observability/rabbitmq-tracing");
const { createHttpMetricsMiddleware } = require("@rootsmarket/observability/http-metrics");

const {
  register,
  httpRequestsTotal,
  httpRequestDuration,
  httpRequestsInFlight,
  paymentsProcessedTotal,
  paymentsFailedTotal,
  rabbitmqMessagesConsumedTotal,
  rabbitmqMessagesPublishedTotal,
} = require("./metrics");

const app = express();

const SERVICE_NAME = "payment-service";
const PORT = process.env.PORT || 3004;
const RABBITMQ_URL = process.env.RABBITMQ_URL || "";

const DEFAULT_EXCHANGE = "";
const ORDER_CREATED_QUEUE = "order.created";
const PAYMENT_COMPLETED_QUEUE = "payment.completed";

const CORS_ORIGIN = (process.env.CORS_ORIGIN || "")
  .split(",")
  .map(origin => origin.trim())
  .filter(Boolean);

app.use(
  cors({
    origin: CORS_ORIGIN.length ? CORS_ORIGIN : true,
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

const pool = new Pool({
  host: process.env.POSTGRES_HOST || "localhost",
  port: Number(process.env.POSTGRES_PORT || 5432),
  database: process.env.POSTGRES_DB || "rootsmarket",
  user: process.env.POSTGRES_USER || "rootsmarket",
  password: process.env.POSTGRES_PASSWORD || "rootsmarket",
  max: Number(process.env.POSTGRES_POOL_MAX || 10),

  // Default idleTimeoutMillis is 10s and the healthcheck runs every 15s, so
  // the pool reaped its last connection between every check and each one
  // paid a fresh TCP connect + DNS lookup. Holding connections past the
  // healthcheck interval keeps one warm and removes that cost from real
  // requests too.
  idleTimeoutMillis: Number(process.env.POSTGRES_IDLE_TIMEOUT_MS || 30000),
  keepAlive: true,
});

let rabbitConnection = null;
let rabbitChannel = null;

app.get("/health", (req, res) =>
  // Suppressed: the SELECT 1 and redis PING below are instrumented, and
  // with /health excluded from HTTP tracing they would each become the
  // root of their own orphan trace, every healthcheck interval.
  withoutTracing(async () => {
    const health = {
      status: "healthy",
      service: SERVICE_NAME,
      dependencies: { postgres: "unknown", rabbitmq: "unknown" },
    };

    try {
      await pool.query("SELECT 1");
      health.dependencies.postgres = "healthy";
    } catch {
      health.status = "unhealthy";
      health.dependencies.postgres = "unhealthy";
    }

    health.dependencies.rabbitmq = rabbitChannel ? "healthy" : "unhealthy";
    if (!rabbitChannel) health.status = "unhealthy";

    res.status(health.status === "healthy" ? 200 : 503).json(health);
  })
);

app.get("/payments", async (req, res, next) => {
  try {
    const result = await pool.query(
      `
      SELECT
        p.id,
        p.order_id,
        p.status,
        p.amount,
        p.created_at,
        o.user_id,
        u.name AS customer_name,
        u.email AS customer_email
      FROM payments p
      JOIN orders o ON o.id = p.order_id
      JOIN users u ON u.id = o.user_id
      ORDER BY p.created_at DESC
      `
    );

    res.json(result.rows);
  } catch (err) {
    next(err);
  }
});

app.get("/payments/:id", async (req, res, next) => {
  try {
    const result = await pool.query(
      `
      SELECT
        p.id,
        p.order_id,
        p.status,
        p.amount,
        p.created_at,
        o.user_id,
        u.name AS customer_name,
        u.email AS customer_email
      FROM payments p
      JOIN orders o ON o.id = p.order_id
      JOIN users u ON u.id = o.user_id
      WHERE p.id = $1
      `,
      [req.params.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "payment not found" });
    }

    res.json(result.rows[0]);
  } catch (err) {
    next(err);
  }
});

// Called from inside the consumer span, so the injected context still carries
// the original trace ID and notification-service joins the same trace.
async function publishPaymentCompleted(event) {
  if (!rabbitChannel) {
    throw new Error("RabbitMQ channel is not available");
  }

  await publishWithTrace(
    rabbitChannel,
    DEFAULT_EXCHANGE,
    PAYMENT_COMPLETED_QUEUE,
    event,
    {
      messageId: String(event.paymentId),
    }
  );

  rabbitmqMessagesPublishedTotal.inc({ queue: PAYMENT_COMPLETED_QUEUE });

  logger.info("payment_completed_event_published", {
    orderId: event.orderId,
    paymentId: event.paymentId,
    amount: event.amount,
  });
}

/**
 * consumeWithTrace owns ack/nack: returning acks, throwing nacks.
 * Do not call rabbitChannel.ack() or .nack() anywhere in here.
 */
async function handleOrderCreated(event) {
  rabbitmqMessagesConsumedTotal.inc({ queue: ORDER_CREATED_QUEUE });

  const client = await pool.connect();

  try {
    logger.info("order_created_event_received", {
      orderId: event.orderId,
      userId: event.userId,
      amount: event.amount,
    });

    await client.query("BEGIN");

    const existingPayment = await client.query(
      `
      SELECT id, status
      FROM payments
      WHERE order_id = $1
      LIMIT 1
      `,
      [event.orderId]
    );

    if (existingPayment.rows.length > 0) {
      await client.query("COMMIT");

      logger.warn("payment_already_exists_message_acknowledged", {
        orderId: event.orderId,
        paymentId: existingPayment.rows[0].id,
      });

      // Returning normally acks — idempotent replay, nothing to retry.
      return;
    }

    const paymentResult = await client.query(
      `
      INSERT INTO payments (order_id, status, amount)
      VALUES ($1, $2, $3)
      RETURNING id, order_id, status, amount, created_at
      `,
      [event.orderId, "completed", event.amount]
    );

    const payment = paymentResult.rows[0];

    await client.query(
      `
      UPDATE orders
      SET status = $1
      WHERE id = $2
      `,
      ["paid", event.orderId]
    );

    await client.query("COMMIT");

    await publishPaymentCompleted({
      event: "payment_completed",
      orderId: event.orderId,
      paymentId: payment.id,
      userId: event.userId,
      amount: Number(payment.amount),
      status: payment.status,
      createdAt: payment.created_at,
    });

    paymentsProcessedTotal.inc();

    logger.info("payment_processed", {
      orderId: event.orderId,
      paymentId: payment.id,
      amount: Number(payment.amount),
    });
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});

    paymentsFailedTotal.inc();

    logger.error("payment_processing_failed", {
      orderId: event?.orderId,
      error: err,
    });

    // Rethrow so consumeWithTrace records the exception and nacks.
    throw err;
  } finally {
    client.release();
  }
}

async function connectRabbitMQ() {
  rabbitConnection = await amqp.connect(RABBITMQ_URL);
  rabbitChannel = await rabbitConnection.createChannel();

  await rabbitChannel.assertQueue(ORDER_CREATED_QUEUE, { durable: true });
  await rabbitChannel.assertQueue(PAYMENT_COMPLETED_QUEUE, { durable: true });

  rabbitChannel.prefetch(1);

  await consumeWithTrace(rabbitChannel, ORDER_CREATED_QUEUE, handleOrderCreated);

  logger.info("rabbitmq_consumer_started", {
    consuming: ORDER_CREATED_QUEUE,
    publishing: PAYMENT_COMPLETED_QUEUE,
  });
}

app.get("/metrics", async (req, res) => {
  res.set("Content-Type", register.contentType);
  res.end(await register.metrics());
});

app.use((err, req, res, next) => {
  logger.error("request_failed", { error: err });

  res.status(500).json({ error: "internal server error" });
});

async function start() {
  await pool.query("SELECT 1");
  logger.info("postgres_connected");

  await connectRabbitMQ();

  app.listen(PORT, () => {
    logger.info("service_started", { port: PORT, corsOrigin: CORS_ORIGIN });
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

  try {
    await pool.end();
  } catch (err) {
    logger.warn("postgres_shutdown_failed", { error: err });
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