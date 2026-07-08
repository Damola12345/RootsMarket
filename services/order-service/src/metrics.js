// Prometheus metrics for order-service
const client = require("prom-client");

// Dedicated registry.
const register = new client.Registry();

// Collect Node.js runtime metrics.
client.collectDefaultMetrics({
  register,
  prefix: "rootsmarket_",
});

// HTTP Metrics
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
  help: "Current number of HTTP requests being processed",
});

// Business Metrics
// Successfully created orders.
const ordersCreatedTotal = new client.Counter({
  name: "orders_created_total",
  help: "Total number of successfully created orders",
});

// Failed order creations.
const ordersFailedTotal = new client.Counter({
  name: "orders_failed_total",
  help: "Total number of failed order creations",
});

// Published RabbitMQ events.
const rabbitmqMessagesPublishedTotal = new client.Counter({
  name: "rabbitmq_messages_published_total",
  help: "Total RabbitMQ messages published",
  labelNames: ["queue"],
});

// Register metrics.
register.registerMetric(httpRequestsTotal);
register.registerMetric(httpRequestDuration);
register.registerMetric(httpRequestsInFlight);
register.registerMetric(ordersCreatedTotal);
register.registerMetric(ordersFailedTotal);
register.registerMetric(rabbitmqMessagesPublishedTotal);

module.exports = {
  register,
  httpRequestsTotal,
  httpRequestDuration,
  httpRequestsInFlight,
  ordersCreatedTotal,
  ordersFailedTotal,
  rabbitmqMessagesPublishedTotal,
};