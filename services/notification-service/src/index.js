require("dotenv").config();

const express = require("express");
const cors = require("cors");
const amqp = require("amqplib");

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
const CORS_ORIGIN = process.env.CORS_ORIGIN || "http://localhost:5173";
const RABBITMQ_URL =
  process.env.RABBITMQ_URL || "amqp://admin:admin@localhost:5672";

const PAYMENT_COMPLETED_QUEUE = "payment.completed";

app.use(cors({ origin: CORS_ORIGIN }));
app.use(express.json());

// Record Prometheus HTTP metrics for every request.
app.use((req, res, next) => {
  httpRequestsInFlight.inc();

  const end = httpRequestDuration.startTimer({
    method: req.method,
    route: req.path,
  });

  res.on("finish", () => {
    end({ status: res.statusCode });

    httpRequestsTotal.inc({
      method: req.method,
      route: req.path,
      status: res.statusCode,
    });

    httpRequestsInFlight.dec();
  });

  next();
});

// Structured JSON logger.
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

let rabbitConnection = null;
let rabbitChannel = null;

app.get("/health", (req, res) => {
  const rabbitHealthy = Boolean(rabbitChannel);

  res.status(rabbitHealthy ? 200 : 503).json({
    status: rabbitHealthy ? "healthy" : "unhealthy",
    service: SERVICE_NAME,
    dependencies: {
      rabbitmq: rabbitHealthy ? "healthy" : "unhealthy",
    },
  });
});

// Process payment.completed messages from RabbitMQ.
async function processPaymentCompleted(message) {
  const raw = message.content.toString();

  // Record RabbitMQ message consumption.
  rabbitmqMessagesConsumedTotal.inc({
    queue: PAYMENT_COMPLETED_QUEUE,
  });

  try {
    const event = JSON.parse(raw);

    log("info", "payment_completed_event_received", {
      orderId: event.orderId,
      paymentId: event.paymentId,
      userId: event.userId,
      amount: event.amount,
      status: event.status,
    });

    // MVP notification action: write a structured log.
    log("info", "notification_sent", {
      type: "payment_confirmation",
      orderId: event.orderId,
      paymentId: event.paymentId,
      message: `Notification sent for order ${event.orderId}`,
    });

    // Record successful notification.
    notificationsSentTotal.inc();

    rabbitChannel.ack(message);
  } catch (err) {
    // Record failed notification handling.
    notificationsFailedTotal.inc();

    log("error", "notification_processing_failed", {
      error: err.message || String(err),
      rawMessage: raw,
    });

    rabbitChannel.nack(message, false, false);
  }
}

// Connect to RabbitMQ and consume payment.completed events.
async function connectRabbitMQ() {
  rabbitConnection = await amqp.connect(RABBITMQ_URL);
  rabbitChannel = await rabbitConnection.createChannel();

  await rabbitChannel.assertQueue(PAYMENT_COMPLETED_QUEUE, {
    durable: true,
  });

  rabbitChannel.prefetch(1);

  await rabbitChannel.consume(PAYMENT_COMPLETED_QUEUE, processPaymentCompleted, {
    noAck: false,
  });

  log("info", "rabbitmq_consumer_started", {
    consuming: PAYMENT_COMPLETED_QUEUE,
  });
}

// Prometheus scrape endpoint.
app.get("/metrics", async (req, res) => {
  res.set("Content-Type", register.contentType);
  res.end(await register.metrics());
});

async function start() {
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
    if (rabbitChannel) {
      await rabbitChannel.close();
    }
  } catch (err) {
    log("warn", "rabbitmq_channel_shutdown_failed", {
      error: err.message || String(err),
    });
  }

  try {
    if (rabbitConnection) {
      await rabbitConnection.close();
    }
  } catch (err) {
    log("warn", "rabbitmq_connection_shutdown_failed", {
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