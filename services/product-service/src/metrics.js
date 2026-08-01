// Prometheus metrics for product-service
const client = require("prom-client");

const register = new client.Registry();

client.collectDefaultMetrics({
  register,
  prefix: "rootsmarket_",
});

// HTTP metrics
const httpRequestsTotal = new client.Counter({
  name: "http_requests_total",
  help: "Total number of HTTP requests",
  labelNames: ["method", "route", "status"],
  registers: [register],
});

const httpRequestDuration = new client.Histogram({
  name: "http_request_duration_seconds",
  help: "HTTP request duration in seconds",
  labelNames: ["method", "route", "status"],
  buckets: [0.005, 0.01, 0.05, 0.1, 0.25, 0.5, 1, 2, 5],
  registers: [register],
});

const httpRequestsInFlight = new client.Gauge({
  name: "http_requests_in_flight",
  help: "Number of in-flight HTTP requests",
  registers: [register],
});

// Product/business metrics
const productsRequestedTotal = new client.Counter({
  name: "products_requested_total",
  help: "Total number of product list requests",
  registers: [register],
});

// Cache metrics
const cacheHitsTotal = new client.Counter({
  name: "cache_hits_total",
  help: "Total number of Redis cache hits",
  labelNames: ["cache_key"],
  registers: [register],
});

const cacheMissesTotal = new client.Counter({
  name: "cache_misses_total",
  help: "Total number of Redis cache misses",
  labelNames: ["cache_key"],
  registers: [register],
});

module.exports = {
  register,
  httpRequestsTotal,
  httpRequestDuration,
  httpRequestsInFlight,
  productsRequestedTotal,
  cacheHitsTotal,
  cacheMissesTotal,
};