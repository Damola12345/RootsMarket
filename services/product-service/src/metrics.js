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
});

const httpRequestDuration = new client.Histogram({
  name: "http_request_duration_seconds",
  help: "HTTP request duration in seconds",
  labelNames: ["method", "route", "status"],
  buckets: [0.005, 0.01, 0.05, 0.1, 0.25, 0.5, 1, 2, 5],
});

const httpRequestsInFlight = new client.Gauge({
  name: "http_requests_in_flight",
  help: "Number of in-flight HTTP requests",
});

// Product/business metrics
const productsRequestedTotal = new client.Counter({
  name: "products_requested_total",
  help: "Total number of product list requests",
});

// Cache metrics
const cacheHitsTotal = new client.Counter({
  name: "cache_hits_total",
  help: "Total number of Redis cache hits",
  labelNames: ["cache_key"],
});

const cacheMissesTotal = new client.Counter({
  name: "cache_misses_total",
  help: "Total number of Redis cache misses",
  labelNames: ["cache_key"],
});

register.registerMetric(httpRequestsTotal);
register.registerMetric(httpRequestDuration);
register.registerMetric(httpRequestsInFlight);
register.registerMetric(productsRequestedTotal);
register.registerMetric(cacheHitsTotal);
register.registerMetric(cacheMissesTotal);

module.exports = {
  register,
  httpRequestsTotal,
  httpRequestDuration,
  httpRequestsInFlight,
  productsRequestedTotal,
  cacheHitsTotal,
  cacheMissesTotal,
};