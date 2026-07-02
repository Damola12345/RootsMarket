require("dotenv").config();

const express = require("express");
const cors = require("cors");
const { Pool } = require("pg");
const amqp = require("amqplib");

const app = express();

const SERVICE_NAME = "payment-service";
const PORT = process.env.PORT || 3004;
const CORS_ORIGIN = process.env.CORS_ORIGIN || "http://localhost:5173";
const RABBITMQ_URL =
  process.env.RABBITMQ_URL || "amqp://admin:admin@localhost:5672";

const ORDER_CREATED_QUEUE = "order.created";
const PAYMENT_COMPLETED_QUEUE = "payment.completed";

app.use(cors({ origin: CORS_ORIGIN }));
app.use(express.json());

function log(level, message, meta = {}) {
  console.log(
    JSON.stringify({
      timestamp: new Date().toISOString(),
      service: SERVICE_NAME,
      level,
      message,
      ...meta,
    })
  );
}

const pool = new Pool({
  host: process.env.POSTGRES_HOST || "localhost",
  port: Number(process.env.POSTGRES_PORT || 5432),
  database: process.env.POSTGRES_DB || "rootsmarket",
  user: process.env.POSTGRES_USER || "rootsmarket",
  password: process.env.POSTGRES_PASSWORD || "rootsmarket",
  max: Number(process.env.POSTGRES_POOL_MAX || 10),
});

let rabbitConnection = null;
let rabbitChannel = null;

app.get("/health", async (req, res) => {
  const health = {
    status: "healthy",
    service: SERVICE_NAME,
    dependencies: {
      postgres: "unknown",
      rabbitmq: "unknown",
    },
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
});

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
      return res.status(404).json({
        error: "payment not found",
      });
    }

    res.json(result.rows[0]);
  } catch (err) {
    next(err);
  }
});

async function publishPaymentCompleted(event) {
  rabbitChannel.sendToQueue(
    PAYMENT_COMPLETED_QUEUE,
    Buffer.from(JSON.stringify(event)),
    {
      persistent: true,
      contentType: "application/json",
    }
  );

  log("info", "payment_completed_event_published", {
    orderId: event.orderId,
    paymentId: event.paymentId,
    amount: event.amount,
  });
}

async function processOrderCreated(message) {
  const raw = message.content.toString();
  const event = JSON.parse(raw);
  const client = await pool.connect();

  try {
    log("info", "order_created_event_received", {
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

      log("warn", "payment_already_exists_message_acknowledged", {
        orderId: event.orderId,
        paymentId: existingPayment.rows[0].id,
      });

      rabbitChannel.ack(message);
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

    rabbitChannel.ack(message);

    log("info", "payment_processed", {
      orderId: event.orderId,
      paymentId: payment.id,
      amount: Number(payment.amount),
    });
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});

    log("error", "payment_processing_failed", {
      error: err.message,
      rawMessage: raw,
    });

    rabbitChannel.nack(message, false, false);
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

  await rabbitChannel.consume(ORDER_CREATED_QUEUE, processOrderCreated, {
    noAck: false,
  });

  log("info", "rabbitmq_consumer_started", {
    consuming: ORDER_CREATED_QUEUE,
    publishing: PAYMENT_COMPLETED_QUEUE,
  });
}

app.use((err, req, res, next) => {
  log("error", "request_failed", {
    error: err.message,
    stack: process.env.NODE_ENV === "production" ? undefined : err.stack,
  });

  res.status(500).json({
    error: "internal server error",
  });
});

async function start() {
  await pool.query("SELECT 1");
  log("info", "postgres_connected");

  await connectRabbitMQ();

  app.listen(PORT, () => {
    log("info", "service_started", {
      port: PORT,
      corsOrigin: CORS_ORIGIN,
    });
  });
}

let isShuttingDown = false;

async function shutdown() {
  if (isShuttingDown) return;
  isShuttingDown = true;

  log("info", "service_shutting_down");

  try {
    if (rabbitChannel) await rabbitChannel.close();
  } catch (err) {
    log("warn", "rabbitmq_channel_shutdown_failed", {
      error: err.message || String(err),
    });
  }

  try {
    if (rabbitConnection) await rabbitConnection.close();
  } catch (err) {
    log("warn", "rabbitmq_connection_shutdown_failed", {
      error: err.message || String(err),
    });
  }

  try {
    await pool.end();
  } catch (err) {
    log("warn", "postgres_shutdown_failed", {
      error: err.message || String(err),
    });
  }

  process.exit(0);
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

start().catch((err) => {
  log("error", "service_start_failed", {
    error: err.message || String(err),
  });

  process.exit(1);
});