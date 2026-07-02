require("dotenv").config();

const express = require("express");
const cors = require("cors");
const { Pool } = require("pg");
const { createClient } = require("redis");
const crypto = require("crypto");

const app = express();

const SERVICE_NAME = "user-service";
const PORT = process.env.PORT || 3001;
const CACHE_TTL_SECONDS = Number(process.env.CACHE_TTL_SECONDS || 60);
const CORS_ORIGIN = process.env.CORS_ORIGIN || "http://localhost:5173";

// Allow frontend requests from Vite during development.
app.use(
  cors({
    origin: CORS_ORIGIN,
  })
);

// Parse incoming JSON request bodies.
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

// Add request ID to every request for traceability.
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

const redisClient = createClient({
  url: process.env.REDIS_URL || "redis://localhost:6379",
});

redisClient.on("error", (err) => {
  log("error", "redis_error", {
    error: err.message || err.code || String(err),
  });
});

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

app.post("/users", async (req, res, next) => {
  try {
    const { name, email } = req.body;

    if (!name || !email) {
      return res.status(400).json({
        error: "name and email are required",
      });
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

    log("info", "user_created", {
      requestId: req.requestId,
      userId: result.rows[0].id,
    });

    res.status(201).json(result.rows[0]);
  } catch (err) {
    if (err.code === "23505") {
      return res.status(409).json({
        error: "email already exists",
      });
    }

    next(err);
  }
});

app.get("/users", async (req, res, next) => {
  try {
    const cacheKey = "users:all";
    const cached = await getCache(cacheKey);

    if (cached) {
      log("info", "cache_hit", {
        requestId: req.requestId,
        key: cacheKey,
      });

      return res.json(cached);
    }

    log("info", "cache_miss", {
      requestId: req.requestId,
      key: cacheKey,
    });

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
      log("info", "cache_hit", {
        requestId: req.requestId,
        key: cacheKey,
      });

      return res.json(cached);
    }

    log("info", "cache_miss", {
      requestId: req.requestId,
      key: cacheKey,
    });

    const result = await pool.query(
      `
      SELECT id, name, email, created_at
      FROM users
      WHERE id = $1
      `,
      [req.params.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        error: "user not found",
      });
    }

    await setCache(cacheKey, result.rows[0]);

    res.json(result.rows[0]);
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

  try {
    await redisClient.connect();
    log("info", "redis_connected");
  } catch (err) {
    log("warn", "redis_connection_failed_cache_disabled", {
      error: err.message || String(err),
    });
  }

  app.listen(PORT, () => {
    log("info", "service_started", { port: PORT, corsOrigin: CORS_ORIGIN });
  });
}

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