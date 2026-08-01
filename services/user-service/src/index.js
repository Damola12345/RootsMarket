require("dotenv").config();

const express = require("express");
const cors = require("cors");
const { Pool } = require("pg");
const { createClient } = require("redis");

const { logger } = require("@rootsmarket/observability/logger");
const { withoutTracing } = require("@rootsmarket/observability/suppress");
const { shutdownTracing } = require("@rootsmarket/observability/tracing");
const {
  createHttpMetricsMiddleware,
  createRequestContextMiddleware,
} = require("@rootsmarket/observability/http-metrics");

const {
  register,
  httpRequestsTotal,
  httpRequestDuration,
  httpRequestsInFlight,
  usersCreatedTotal,
} = require("./metrics");

const app = express();

const SERVICE_NAME = "user-service";
const PORT = process.env.PORT || 3001;
const CACHE_TTL_SECONDS = Number(process.env.CACHE_TTL_SECONDS || 60);

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
});

const redisClient = createClient({
  url: process.env.REDIS_URL || "redis://localhost:6379",
});

redisClient.on("error", (err) => {
  logger.error("redis_error", { error: err });
});

async function getCache(key) {
  if (!redisClient.isOpen) return null;

  try {
    const value = await redisClient.get(key);
    return value ? JSON.parse(value) : null;
  } catch (err) {
    logger.warn("cache_get_failed", { key, error: err });
    return null;
  }
}

async function setCache(key, value, ttl = CACHE_TTL_SECONDS) {
  if (!redisClient.isOpen) return;

  try {
    await redisClient.set(key, JSON.stringify(value), { EX: ttl });
  } catch (err) {
    logger.warn("cache_set_failed", { key, error: err });
  }
}

async function deleteCache(keys) {
  if (!redisClient.isOpen) return;

  try {
    if (keys.length > 0) {
      await redisClient.del(keys);
    }
  } catch (err) {
    logger.warn("cache_delete_failed", { keys, error: err });
  }
}

app.get("/health", (req, res) =>
  // Suppressed: the SELECT 1 and redis PING below are instrumented, and
  // with /health excluded from HTTP tracing they would each become the
  // root of their own orphan trace, every healthcheck interval.
  withoutTracing(async () => {
    const health = {
      status: "healthy",
      service: SERVICE_NAME,
      dependencies: { postgres: "unknown", redis: "unknown" },
    };

    try {
      await pool.query("SELECT 1");
      health.dependencies.postgres = "healthy";
    } catch {
      health.status = "unhealthy";
      health.dependencies.postgres = "unhealthy";
    }

    try {
      if (redisClient.isOpen) {
        await redisClient.ping();
        health.dependencies.redis = "healthy";
      } else {
        health.dependencies.redis = "not_connected";
      }
    } catch {
      health.dependencies.redis = "unhealthy";
    }

    res.status(health.status === "healthy" ? 200 : 503).json(health);
  })
);

app.post("/users", async (req, res, next) => {
  try {
    const { name, email } = req.body;

    if (!name || !email) {
      return res.status(400).json({ error: "name and email are required" });
    }

    const result = await pool.query(
      `
      INSERT INTO users (name, email)
      VALUES ($1, $2)
      RETURNING id, name, email, created_at
      `,
      [name, email]
    );

    await deleteCache(["users:all"]);

    usersCreatedTotal.inc();

    logger.info("user_created", {
      requestId: req.requestId,
      userId: result.rows[0].id,
    });

    res.status(201).json(result.rows[0]);
  } catch (err) {
    if (err.code === "23505") {
      return res.status(409).json({ error: "email already exists" });
    }

    next(err);
  }
});

app.get("/users", async (req, res, next) => {
  try {
    const cacheKey = "users:all";
    const cached = await getCache(cacheKey);

    if (cached) {
      logger.info("cache_hit", { requestId: req.requestId, key: cacheKey });
      return res.json(cached);
    }

    logger.info("cache_miss", { requestId: req.requestId, key: cacheKey });

    const result = await pool.query(
      `
      SELECT id, name, email, created_at
      FROM users
      ORDER BY created_at DESC
      `
    );

    await setCache(cacheKey, result.rows);

    res.json(result.rows);
  } catch (err) {
    next(err);
  }
});

app.get("/users/:id", async (req, res, next) => {
  try {
    const cacheKey = `users:${req.params.id}`;
    const cached = await getCache(cacheKey);

    if (cached) {
      logger.info("cache_hit", { requestId: req.requestId, key: cacheKey });
      return res.json(cached);
    }

    logger.info("cache_miss", { requestId: req.requestId, key: cacheKey });

    const result = await pool.query(
      `
      SELECT id, name, email, created_at
      FROM users
      WHERE id = $1
      `,
      [req.params.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "user not found" });
    }

    await setCache(cacheKey, result.rows[0]);

    res.json(result.rows[0]);
  } catch (err) {
    next(err);
  }
});

app.get("/metrics", async (req, res) => {
  res.set("Content-Type", register.contentType);
  res.end(await register.metrics());
});

app.use((err, req, res, next) => {
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
  await pool.query("SELECT 1");
  logger.info("postgres_connected");

  try {
    await redisClient.connect();
    logger.info("redis_connected");
  } catch (err) {
    logger.warn("redis_connection_failed_cache_disabled", { error: err });
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
    if (redisClient.isOpen) {
      await redisClient.quit();
    }
  } catch (err) {
    logger.warn("redis_shutdown_failed", { error: err });
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