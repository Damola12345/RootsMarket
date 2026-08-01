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
  productsRequestedTotal,
  cacheHitsTotal,
  cacheMissesTotal,
} = require("./metrics");

const app = express();

const SERVICE_NAME = "product-service";
const PORT = process.env.PORT || 3002;
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

// Parse incoming JSON request bodies.
app.use(express.json());

// Record Prometheus HTTP metrics for every request.
app.use(
  createHttpMetricsMiddleware({
    httpRequestsTotal,
    httpRequestDuration,
    httpRequestsInFlight,
  })
);

// Add request ID to every request for tracing/debugging.
app.use(createRequestContextMiddleware(logger));

// PostgreSQL stores product data permanently.
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

// Redis caches product reads.
const redisClient = createClient({
  url: process.env.REDIS_URL || "redis://localhost:6379",
});

redisClient.on("error", (err) => {
  logger.error("redis_error", { error: err });
});

// Read from Redis cache. If Redis fails, continue with Postgres.
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

// Write data to Redis cache with TTL.
async function setCache(key, value, ttl = CACHE_TTL_SECONDS) {
  if (!redisClient.isOpen) return;

  try {
    await redisClient.set(key, JSON.stringify(value), { EX: ttl });
  } catch (err) {
    logger.warn("cache_set_failed", { key, error: err });
  }
}

// Remove stale cache after product changes.
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

// Health endpoint for Docker/Kubernetes checks.
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

// List products using cache-aside pattern: Redis -> Postgres -> Redis.
app.get("/products", async (req, res, next) => {
  try {
    productsRequestedTotal.inc();

    const cacheKey = "products:all";
    const cached = await getCache(cacheKey);

    if (cached) {
      cacheHitsTotal.inc({ cache_key: cacheKey });

      logger.info("cache_hit", { requestId: req.requestId, key: cacheKey });

      return res.json(cached);
    }

    cacheMissesTotal.inc({ cache_key: cacheKey });

    logger.info("cache_miss", { requestId: req.requestId, key: cacheKey });

    const result = await pool.query(
      `
      SELECT id, name, price, stock, created_at
      FROM products
      ORDER BY name ASC
      `
    );

    await setCache(cacheKey, result.rows);

    res.json(result.rows);
  } catch (err) {
    next(err);
  }
});

// Create a new product.
app.post("/products", async (req, res, next) => {
  try {
    const { name, price, stock } = req.body;

    if (!name || price === undefined || stock === undefined) {
      return res.status(400).json({
        error: "name, price, and stock are required",
      });
    }

    if (Number(price) < 0 || Number(stock) < 0) {
      return res.status(400).json({
        error: "price and stock must be greater than or equal to 0",
      });
    }

    const result = await pool.query(
      `
      INSERT INTO products (name, price, stock)
      VALUES ($1, $2, $3)
      RETURNING id, name, price, stock, created_at
      `,
      [name, price, stock]
    );

    await deleteCache(["products:all"]);

    logger.info("product_created", {
      requestId: req.requestId,
      productId: result.rows[0].id,
    });

    res.status(201).json(result.rows[0]);
  } catch (err) {
    next(err);
  }
});

// Update product details or stock.
app.put("/products/:id", async (req, res, next) => {
  try {
    const { name, price, stock } = req.body;

    if (!name && price === undefined && stock === undefined) {
      return res.status(400).json({
        error: "at least one of name, price, or stock is required",
      });
    }

    if (price !== undefined && Number(price) < 0) {
      return res.status(400).json({
        error: "price must be greater than or equal to 0",
      });
    }

    if (stock !== undefined && Number(stock) < 0) {
      return res.status(400).json({
        error: "stock must be greater than or equal to 0",
      });
    }

    const result = await pool.query(
      `
      UPDATE products
      SET
        name = COALESCE($1, name),
        price = COALESCE($2, price),
        stock = COALESCE($3, stock)
      WHERE id = $4
      RETURNING id, name, price, stock, created_at
      `,
      [name || null, price ?? null, stock ?? null, req.params.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "product not found" });
    }

    await deleteCache(["products:all"]);

    logger.info("product_updated", {
      requestId: req.requestId,
      productId: result.rows[0].id,
    });

    res.json(result.rows[0]);
  } catch (err) {
    next(err);
  }
});

// Prometheus scrape endpoint.
app.get("/metrics", async (req, res) => {
  res.set("Content-Type", register.contentType);
  res.end(await register.metrics());
});

// Central error handler.
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

// Start service. Postgres is required; Redis is optional cache.
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

// Graceful shutdown.
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