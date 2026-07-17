
// Prometheus metrics for user-service
const client = require("prom-client");

// Create a dedicated registry for this service.
const register = new client.Registry();

// Collect default Node.js process metrics.
client.collectDefaultMetrics({
  register,
  prefix: "rootsmarket_",
});


// HTTP Metrics
// Total HTTP requests received.
const httpRequestsTotal = new client.Counter({
  name: "http_requests_total",
  help: "Total number of HTTP requests",
  labelNames: ["method", "route", "status"],
});

// Duration of HTTP requests.
const httpRequestDuration = new client.Histogram({
  name: "http_request_duration_seconds",
  help: "HTTP request duration in seconds",
  labelNames: ["method", "route", "status"],

  // Buckets from very fast to slow requests.
  buckets: [0.005, 0.01, 0.05, 0.1, 0.25, 0.5, 1, 2, 5],
});

// Number of currently active HTTP requests.
const httpRequestsInFlight = new client.Gauge({
  name: "http_requests_in_flight",
  help: "Number of in-flight HTTP requests",
});

// Business Metrics
// Number of users successfully created.
const usersCreatedTotal = new client.Counter({
  name: "users_created_total",
  help: "Total number of users created",
});

// Register all custom metrics.
register.registerMetric(httpRequestsTotal);
register.registerMetric(httpRequestDuration);
register.registerMetric(httpRequestsInFlight);
register.registerMetric(usersCreatedTotal);

module.exports = {
  register,
  httpRequestsTotal,
  httpRequestDuration,
  httpRequestsInFlight,
  usersCreatedTotal,
};