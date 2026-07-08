const client = require("prom-client");

const register = new client.Registry();

client.collectDefaultMetrics({
  register,
  prefix: "rootsmarket_",
});

// HTTP request metrics.
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
  help: "Current number of in-flight HTTP requests",
});

// Business metrics.
const notificationsSentTotal = new client.Counter({
  name: "notifications_sent_total",
  help: "Total number of notifications sent",
});

const notificationsFailedTotal = new client.Counter({
  name: "notifications_failed_total",
  help: "Total number of failed notifications",
});

const rabbitmqMessagesConsumedTotal = new client.Counter({
  name: "rabbitmq_messages_consumed_total",
  help: "Total RabbitMQ messages consumed",
  labelNames: ["queue"],
});

register.registerMetric(httpRequestsTotal);
register.registerMetric(httpRequestDuration);
register.registerMetric(httpRequestsInFlight);
register.registerMetric(notificationsSentTotal);
register.registerMetric(notificationsFailedTotal);
register.registerMetric(rabbitmqMessagesConsumedTotal);

module.exports = {
  register,
  httpRequestsTotal,
  httpRequestDuration,
  httpRequestsInFlight,
  notificationsSentTotal,
  notificationsFailedTotal,
  rabbitmqMessagesConsumedTotal,
};