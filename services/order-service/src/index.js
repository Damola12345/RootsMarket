require("dotenv").config();

const express = require("express");
const cors = require("cors");
const { Pool } = require("pg");
const amqp = require("amqplib");
const crypto = require("crypto");

const app = express();

const SERVICE_NAME = "order-service";
const PORT = process.env.PORT || 3003;
const CORS_ORIGIN = process.env.CORS_ORIGIN || "http://localhost:5173";
const RABBITMQ_URL =
  process.env.RABBITMQ_URL || "amqp://admin:admin@localhost:5672";

const ORDER_CREATED_QUEUE = "order.created";

app.use(
  cors({
    origin: CORS_ORIGIN,
  })
);

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

app.use((req, res, next) => {
  req.requestId = req.headers["x-request-id"] || crypto.randomUUID();
  res.setHeader("x-request-id", req.requestId);

  log("info", "request_received", {
    requestId: req.requestId,
    method: req.method,
    path: req.path,
  });

  next();
});

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

async function connectRabbitMQ() {
  rabbitConnection = await amqp.connect(RABBITMQ_URL);
  rabbitChannel = await rabbitConnection.createChannel();

  await rabbitChannel.assertQueue(ORDER_CREATED_QUEUE, {
    durable: true,
  });

  log("info", "rabbitmq_connected", {
    queue: ORDER_CREATED_QUEUE,
  });
}

async function publishOrderCreated(event) {
  if (!rabbitChannel) {
    throw new Error("RabbitMQ channel is not available");
  }

  rabbitChannel.sendToQueue(
    ORDER_CREATED_QUEUE,
    Buffer.from(JSON.stringify(event)),
    {
      persistent: true,
      contentType: "application/json",
    }
  );

  log("info", "order_created_event_published", {
    orderId: event.orderId,
    userId: event.userId,
    amount: event.amount,
  });
}

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

  if (rabbitChannel) {
    health.dependencies.rabbitmq = "healthy";
  } else {
    health.status = "unhealthy";
    health.dependencies.rabbitmq = "unhealthy";
  }

  res.status(health.status === "healthy" ? 200 : 503).json(health);
});

app.post("/orders", async (req, res, next) => {
  const client = await pool.connect();

  try {
    const { userId, items } = req.body;

    if (!userId || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({
        error: "userId and at least one order item are required",
      });
    }

    for (const item of items) {
      if (!item.productId || !item.quantity || Number(item.quantity) <= 0) {
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
      return res.status(404).json({
        error: "user not found",
      });
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
        return res.status(404).json({
          error: `product not found: ${item.productId}`,
        });
      }

      const product = productResult.rows[0];
      const quantity = Number(item.quantity);

      if (product.stock < quantity) {
        await client.query("ROLLBACK");
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

    log("info", "order_created", {
      requestId: req.requestId,
      orderId: order.id,
      userId,
      amount: totalAmount,
    });

    res.status(201).json({
      ...order,
      items: orderItems,
    });
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
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
      return res.status(404).json({
        error: "order not found",
      });
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

    res.json({
      ...orderResult.rows[0],
      items: itemsResult.rows,
    });
  } catch (err) {
    next(err);
  }
});

app.use((err, req, res, next) => {
  log("error", "request_failed", {
    requestId: req.requestId,
    error: err.message,
    stack: process.env.NODE_ENV === "production" ? undefined : err.stack,
  });

  res.status(500).json({
    error: "internal server error",
    requestId: req.requestId,
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