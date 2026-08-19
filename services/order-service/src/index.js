require("dotenv").config();

const express = require("express");
const cors = require("cors");
const { Pool } = require("pg");
const amqp = require("amqplib");

const { logger } = require("@rootsmarket/observability/logger");
const { withoutTracing } = require("@rootsmarket/observability/suppress");
const { shutdownTracing } = require("@rootsmarket/observability/tracing");
const { publishWithTrace } = require("@rootsmarket/observability/rabbitmq-tracing");
const {
  createHttpMetricsMiddleware,
  createRequestContextMiddleware,
} = require("@rootsmarket/observability/http-metrics");

const {
  register,
  httpRequestsTotal,
  httpRequestDuration,
  httpRequestsInFlight,
  ordersCreatedTotal,
  ordersFailedTotal,
  rabbitmqMessagesPublishedTotal,
} = require("./metrics");

const app = express();

const SERVICE_NAME = "order-service";
const PORT = process.env.PORT || 3003;
const RABBITMQ_URL = process.env.RABBITMQ_URL || "";

// Default exchange: routing key is the queue name.
const ORDER_CREATED_EXCHANGE = "";
const ORDER_CREATED_QUEUE = "order.created";

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

app.use(createRequestContextMiddleware(logger));

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

  // Fail fast when Postgres is unreachable. Without this the pool waits
  // indefinitely, /health never responds, and a probe cannot tell "down"
  // from "slow" — curl reports 000 rather than an honest 503.
  connectionTimeoutMillis: Number(process.env.POSTGRES_CONNECT_TIMEOUT_MS || 3000),
});

// pg.Pool emits "error" on idle clients when the server goes away. With no
// listener Node treats it as an uncaught exception and the process dies —
// exactly the amqplib failure mode, on the other dependency. The pool
// reconnects on the next query by itself; it only needs to not crash first.
pool.on("error", (err) => {
  logger.warn("postgres_pool_error", {
    error: err.message || String(err),
  });
});

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

async function connectRabbitMQ() {
  rabbitConnection = await amqp.connect(RABBITMQ_URL);
  rabbitChannel = await rabbitConnection.createChannel();

  wireRabbitLifecycle();

  await rabbitChannel.assertQueue(ORDER_CREATED_QUEUE, { durable: true });

  rabbitReady = true;

  logger.info("rabbitmq_connected", { queue: ORDER_CREATED_QUEUE });
}

// publishWithTrace opens the PRODUCER span and injects traceparent for us.
async function publishOrderCreated(event) {
  if (!rabbitChannel) {
    throw new Error("RabbitMQ channel is not available");
  }

  await publishWithTrace(
    rabbitChannel,
    ORDER_CREATED_EXCHANGE,
    ORDER_CREATED_QUEUE,
    event,
    {
      messageId: String(event.orderId),
    }
  );

  rabbitmqMessagesPublishedTotal.inc({ queue: ORDER_CREATED_QUEUE });

  logger.info("order_created_event_published", {
    orderId: event.orderId,
    userId: event.userId,
    amount: event.amount,
  });
}

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

    if (rabbitReady) {
      health.dependencies.rabbitmq = "healthy";
    } else {
      health.status = "unhealthy";
      health.dependencies.rabbitmq = "unhealthy";
    }

    res.status(health.status === "healthy" ? 200 : 503).json(health);
  })
);

app.post("/orders", async (req, res, next) => {
  const client = await pool.connect();

  try {
    const { userId, items } = req.body;

    if (!userId || !Array.isArray(items) || items.length === 0) {
      ordersFailedTotal.inc();

      return res.status(400).json({
        error: "userId and at least one order item are required",
      });
    }

    for (const item of items) {
      if (!item.productId || !item.quantity || Number(item.quantity) <= 0) {
        ordersFailedTotal.inc();

        return res.status(400).json({
          error: "each item requires productId and quantity greater than 0",
        });
      }
    }

    await client.query("BEGIN");

    const userResult = await client.query(
      `
      SELECT id
      FROM users
      WHERE id = $1
      `,
      [userId]
    );

    if (userResult.rows.length === 0) {
      await client.query("ROLLBACK");
      ordersFailedTotal.inc();

      return res.status(404).json({ error: "user not found" });
    }

    let totalAmount = 0;
    const orderItems = [];

    for (const item of items) {
      const productResult = await client.query(
        `
        SELECT id, name, price, stock
        FROM products
        WHERE id = $1
        FOR UPDATE
        `,
        [item.productId]
      );

      if (productResult.rows.length === 0) {
        await client.query("ROLLBACK");
        ordersFailedTotal.inc();

        return res.status(404).json({
          error: `product not found: ${item.productId}`,
        });
      }

      const product = productResult.rows[0];
      const quantity = Number(item.quantity);

      if (product.stock < quantity) {
        await client.query("ROLLBACK");
        ordersFailedTotal.inc();

        return res.status(409).json({
          error: `insufficient stock for product: ${product.name}`,
        });
      }

      const price = Number(product.price);

      totalAmount += price * quantity;

      orderItems.push({
        productId: product.id,
        productName: product.name,
        quantity,
        price,
      });
    }

    const orderResult = await client.query(
      `
      INSERT INTO orders (user_id, status, total_amount)
      VALUES ($1, $2, $3)
      RETURNING id, user_id, status, total_amount, created_at
      `,
      [userId, "pending", totalAmount]
    );

    const order = orderResult.rows[0];

    for (const item of orderItems) {
      await client.query(
        `
        INSERT INTO order_items (order_id, product_id, quantity, price)
        VALUES ($1, $2, $3, $4)
        `,
        [order.id, item.productId, item.quantity, item.price]
      );

      await client.query(
        `
        UPDATE products
        SET stock = stock - $1
        WHERE id = $2
        `,
        [item.quantity, item.productId]
      );
    }

    await client.query("COMMIT");

    const event = {
      event: "order_created",
      orderId: order.id,
      userId: order.user_id,
      amount: Number(order.total_amount),
      items: orderItems,
      createdAt: order.created_at,
    };

    await publishOrderCreated(event);

    ordersCreatedTotal.inc();

    logger.info("order_created", {
      requestId: req.requestId,
      orderId: order.id,
      userId,
      amount: totalAmount,
    });

    res.status(201).json({ ...order, items: orderItems });
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});

    ordersFailedTotal.inc();

    next(err);
  } finally {
    client.release();
  }
});

app.get("/orders", async (req, res, next) => {
  try {
    const result = await pool.query(
      `
      SELECT
        o.id,
        o.user_id,
        u.name AS customer_name,
        u.email AS customer_email,
        o.status,
        o.total_amount,
        o.created_at
      FROM orders o
      JOIN users u ON u.id = o.user_id
      ORDER BY o.created_at DESC
      `
    );

    res.json(result.rows);
  } catch (err) {
    next(err);
  }
});

app.get("/orders/:id", async (req, res, next) => {
  try {
    const orderResult = await pool.query(
      `
      SELECT
        o.id,
        o.user_id,
        u.name AS customer_name,
        u.email AS customer_email,
        o.status,
        o.total_amount,
        o.created_at
      FROM orders o
      JOIN users u ON u.id = o.user_id
      WHERE o.id = $1
      `,
      [req.params.id]
    );

    if (orderResult.rows.length === 0) {
      return res.status(404).json({ error: "order not found" });
    }

    const itemsResult = await pool.query(
      `
      SELECT
        oi.id,
        oi.product_id,
        p.name AS product_name,
        oi.quantity,
        oi.price
      FROM order_items oi
      JOIN products p ON p.id = oi.product_id
      WHERE oi.order_id = $1
      ORDER BY p.name ASC
      `,
      [req.params.id]
    );

    res.json({ ...orderResult.rows[0], items: itemsResult.rows });
  } catch (err) {
    next(err);
  }
});

app.get("/metrics", async (req, res) => {
  res.set("Content-Type", register.contentType);
  res.end(await register.metrics());
});

app.use((err, req, res, next) => {
  // 22P02 is invalid_text_representation: a malformed UUID or number in the
  // request reached Postgres. That is a client error, not a server fault.
  // Left as a 500 it inflates the 5xx ratio the alert rule watches, so a
  // mistyped id during a demo would page someone. Logged at warn so it also
  // stays out of the error panels.
  if (err.code === "22P02") {
    logger.warn("invalid_input_syntax", {
      requestId: req.requestId,
      error: err.message,
    });

    return res.status(400).json({
      error: "malformed identifier in request",
      requestId: req.requestId,
    });
  }

  logger.error("request_failed", {
    requestId: req.requestId,
    error: err,
  });

  res.status(500).json({
    error: "internal server error",
    requestId: req.requestId,
  });
});

async function start() {
  // Do NOT exit when Postgres is unreachable at boot. Compose removes the
  // DNS entry for a stopped container, so this throws ENOTFOUND, and
  // process.exit(1) + restart:unless-stopped becomes a crash loop —
  // the service is then unreachable rather than reporting 503 honestly.
  try {
    await pool.query("SELECT 1");
    logger.info("postgres_connected");
  } catch (err) {
    logger.warn("postgres_initial_connect_failed", {
      error: err.message || String(err),
    });
  }

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