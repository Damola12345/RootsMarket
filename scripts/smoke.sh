#!/usr/bin/env bash
#
# smoke.sh — manual checks against the running stack.
# For ad-hoc poking; e2e-test.sh is the one that asserts.

set -uo pipefail

# Seed ids are stable, so fetch them once instead of per request.
USER_ID=$(curl -s localhost:3001/users    | python3 -c 'import sys,json;print(json.load(sys.stdin)[0]["id"])')
PROD_ID=$(curl -s localhost:3002/products | python3 -c 'import sys,json;print(json.load(sys.stdin)[0]["id"])')
echo "user=$USER_ID product=$PROD_ID"

# Place one order; the full publish -> consume -> publish -> consume chain.
place_order() {
  curl -s -o /dev/null -X POST localhost:3003/orders \
    -H 'Content-Type: application/json' \
    -d "{\"userId\":\"$USER_ID\",\"items\":[{\"productId\":\"$PROD_ID\",\"quantity\":1}]}"
}

# Repeated reads so the cache hit ratio has something to divide by.
warm_cache() { for _ in $(seq 1 10); do curl -s -o /dev/null localhost:3002/products; done; }

# Steady traffic so rate() windows are non-zero when a dashboard is captured.
generate_traffic() { for _ in $(seq 1 5); do place_order; sleep 4; done; }

# Are the dependencies reachable, per their exporters rather than per `up`.
check_deps() {
  for m in pg_up redis_up; do
    printf '%-10s ' "$m"
    curl -s -G localhost:9090/api/v1/query --data-urlencode "query=$m" \
      | python3 -c 'import sys,json
r = json.load(sys.stdin)["data"]["result"]
print(r[0]["value"][1] if r else "NOT FOUND")'
  done
}

# Did the trace id survive both broker hops?
check_propagation() {
  docker compose logs --since 60s order-service payment-service notification-service \
    | grep -E 'order_created_event_published|payment_completed_event_published|notification_sent'
}

# Is the collector receiving and forwarding spans, or silently dropping them?
check_collector() {
  curl -s localhost:8888/metrics \
    | grep -E 'otelcol_(receiver_accepted|exporter_sent|exporter_send_failed|processor_refused)'
}

# Are the RabbitMQ recording rules producing series for the dashboard panel?
check_recording_rules() {
  curl -s -G localhost:9090/api/v1/query \
    --data-urlencode 'query=count by (__name__) ({__name__=~"rootsmarket:rabbitmq.*"})' \
    | python3 -c 'import sys,json
r = json.load(sys.stdin)["data"]["result"]
print("recording rules producing series:", len(r))
for x in r: print("  ", x["metric"]["__name__"], "=", x["value"][1])'
}

check_deps
warm_cache
generate_traffic

# rate([5m]) needs two samples and the rule group evaluates every 30s.
echo "waiting 90s for rate windows to fill..."
sleep 90

check_propagation
check_collector
check_recording_rules