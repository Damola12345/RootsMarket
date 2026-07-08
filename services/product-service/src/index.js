require("dotenv").config();

const express = require("express");
const cors = require("cors");
const { Pool } = require("pg");
const { createClient } = require("redis");
const crypto = require("crypto");

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
const CORS_ORIGIN = process.env.CORS_ORIGIN || "http://localhost:5173";

// Allow frontend requests.
app.use(cors({ origin: CORS_ORIGIN }));

// Parse incoming JSON request bodies.
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

// Structured JSON logger for Loki/Grafana later.
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

// Add request ID to every request for tracing/debugging.
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

// PostgreSQL stores product data permanently.
const pool = new Pool({
  host: process.env.POSTGRES_HOST || "localhost",
  port: Number(process.env.POSTGRES_PORT || 5432),
  database: process.env.POSTGRES_DB || "rootsmarket",
  user: process.env.POSTGRES_USER || "rootsmarket",
  password: process.env.POSTGRES_PASSWORD || "rootsmarket",
  max: Number(process.env.POSTGRES_POOL_MAX || 10),
});

// Redis caches product reads.
const redisClient = createClient({
  url: process.env.REDIS_URL || "redis://localhost:6379",
});

redisClient.on("error", (err) => {
  log("error", "redis_error", {
    error: err.message || err.code || String(err),
  });
});

// Read from Redis cache. If Redis fails, continue with Postgres.
async function getCache(key) {
  if (!redisClient.isOpen) return null;

  try {
    const value = await redisClient.get(key);
    return value ? JSON.parse(value) : null;
  } catch (err) {
    log("warn", "cache_get_failed", {
      key,
      error: err.message || String(err),
    });

    return null;
  }
}

// Write data to Redis cache with TTL.
async function setCache(key, value, ttl = CACHE_TTL_SECONDS) {
  if (!redisClient.isOpen) return;

  try {
    await redisClient.set(key, JSON.stringify(value), { EX: ttl });
  } catch (err) {
    log("warn", "cache_set_failed", {
      key,
      error: err.message || String(err),
    });
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
    log("warn", "cache_delete_failed", {
      keys,
      error: err.message || String(err),
    });
  }
}

// Health endpoint for Docker/Kubernetes checks.
app.get("/health", async (req, res) => {
  const health = {
    status: "healthy",
    service: SERVICE_NAME,
    dependencies: {
      postgres: "unknown",
      redis: "unknown",
    },
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
});

// List products using cache-aside pattern: Redis → Postgres → Redis.
app.get("/products", async (req, res, next) => {
  try {
    productsRequestedTotal.inc();

    const cacheKey = "products:all";
    const cached = await getCache(cacheKey);

    if (cached) {
      cacheHitsTotal.inc({ cache_key: cacheKey });

      log("info", "cache_hit", {
        requestId: req.requestId,
        key: cacheKey,
      });

      return res.json(cached);
    }

    cacheMissesTotal.inc({ cache_key: cacheKey });

    log("info", "cache_miss", {
      requestId: req.requestId,
      key: cacheKey,
    });

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

    log("info", "product_created", {
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
      return res.status(404).json({
        error: "product not found",
      });
    }

    await deleteCache(["products:all"]);

    log("info", "product_updated", {
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

// Start service. Postgres is required; Redis is optional cache.
async function start() {
  await pool.query("SELECT 1");
  log("info", "postgres_connected");

  try {
    await redisClient.connect();
    log("info", "redis_connected");
  } catch (err) {
    log("warn", "redis_connection_failed_cache_disabled", {
      error: err.message || String(err),
    });
  }

  app.listen(PORT, () => {
    log("info", "service_started", {
      port: PORT,
      corsOrigin: CORS_ORIGIN,
    });
  });
}

// Graceful shutdown.
let isShuttingDown = false;

async function shutdown() {
  if (isShuttingDown) return;
  isShuttingDown = true;

  log("info", "service_shutting_down");

  try {
    if (redisClient.isOpen) {
      await redisClient.quit();
    }
  } catch (err) {
    log("warn", "redis_shutdown_failed", {
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