#!/usr/bin/env bash
# e2e-test.sh — end-to-end verification of the RootsMarket observability stack.
#   ./scripts/e2e-test.sh                    non-destructive (default)
#   ./scripts/e2e-test.sh --with-failure     also runs the induced-failure test


set -uo pipefail

PROM=${PROM:-http://localhost:9090}
TEMPO=${TEMPO:-http://localhost:3200}
LOKI=${LOKI:-http://localhost:3100}
COLLECTOR=${COLLECTOR:-http://localhost:8888}

# bash 3.2 has no `declare -A`; use a space-separated name:port list instead.
SERVICES="user-service:3001 product-service:3002 order-service:3003 payment-service:3004 notification-service:3005"

WITH_FAILURE=0
[ "${1:-}" = "--with-failure" ] && WITH_FAILURE=1

pass=0; fail=0
ok()   { printf '  \033[32mPASS\033[0m  %s\n' "$*"; pass=$((pass+1)); }
no()   { printf '  \033[31mFAIL\033[0m  %s\n' "$*"; fail=$((fail+1)); }
info() { printf '        \033[2m%s\033[0m\n' "$*"; }
step() { printf '\n\033[1m%s\033[0m\n' "$*"; }

#1. containers
step "1. Containers healthy"
running=$(docker compose ps --status running -q | wc -l | tr -d ' ')
unhealthy=$(docker compose ps --format '{{.Name}} {{.State}} {{.Health}}' 2>/dev/null \
            | awk '$3 != "" && $3 != "healthy" {print $1"("$3")"}')
# Guard on `running` too: an empty $unhealthy also results from a compose
# version that does not support this --format template, which would otherwise
# read as a pass with nothing actually up.
if [ -n "$unhealthy" ]; then
  no "unhealthy: $unhealthy"
elif [ "$running" -eq 0 ]; then
  no "no running containers — is the stack up?"
else
  ok "$running running, none unhealthy"
fi

#2. health
step "2. Service health endpoints"
for entry in $SERVICES; do
  svc=${entry%%:*}
  port=${entry##*:}
  code=$(curl -s --max-time 10 -o /dev/null -w '%{http_code}' "http://localhost:$port/health")
  if [ "$code" = "200" ]; then ok "$svc -> 200"; else no "$svc -> $code"; fi
done

#3. scrapes
step "3. Prometheus scrape targets"
down=$(curl -s -G "$PROM/api/v1/query" --data-urlencode 'query=up==0' \
       | python3 -c 'import sys,json
try:
    d=json.load(sys.stdin)
    print(" ".join(r["metric"].get("job","?") for r in d["data"]["result"]))
except Exception: print("QUERY_FAILED")' 2>/dev/null)
total=$(curl -s -G "$PROM/api/v1/query" --data-urlencode 'query=count(up)' \
       | python3 -c 'import sys,json
try: print(json.load(sys.stdin)["data"]["result"][0]["value"][1])
except Exception: print(0)' 2>/dev/null)

if [ "$down" = "QUERY_FAILED" ] || [ "${total:-0}" -eq 0 ] 2>/dev/null; then
  no "could not reach Prometheus"
elif [ -n "$down" ]; then
  no "targets DOWN: $down"
else
  ok "$total targets, all UP"
fi

# Without collector self-metrics, dropped spans are invisible.
if curl -sf "$COLLECTOR/metrics" >/dev/null 2>&1; then
  ok "collector self-metrics reachable on :8888"
else
  no "collector self-metrics unreachable"
fi

#4. malformed input
step "4. Malformed UUID returns 400, not 500"
code=$(curl -s --max-time 10 -o /dev/null -w '%{http_code}' -X POST http://localhost:3003/orders \
       -H 'Content-Type: application/json' \
       -d '{"userId":"not-a-uuid","items":[{"productId":"also-not","quantity":1}]}')
if [ "$code" = "400" ]; then
  ok "22P02 mapped to 400 (keeps the 5xx ratio meaningful)"
else
  no "expected 400, got $code"
fi

#5. order
step "5. Create an order (exercises the full chain)"
USER_ID=$(curl -s http://localhost:3001/users | python3 -c 'import sys,json;print(json.load(sys.stdin)[0]["id"])' 2>/dev/null)
PROD_ID=$(curl -s http://localhost:3002/products | python3 -c 'import sys,json;print(json.load(sys.stdin)[0]["id"])' 2>/dev/null)
ORDER_ID=""
if [ -z "${USER_ID:-}" ] || [ -z "${PROD_ID:-}" ]; then
  no "could not read seed user/product — is the DB seeded?"
else
  info "user=$USER_ID product=$PROD_ID"
  ORDER=$(curl -s -X POST http://localhost:3003/orders -H 'Content-Type: application/json' \
          -d "{\"userId\":\"$USER_ID\",\"items\":[{\"productId\":\"$PROD_ID\",\"quantity\":1}]}")
  ORDER_ID=$(echo "$ORDER" | python3 -c 'import sys,json;print(json.load(sys.stdin).get("id",""))' 2>/dev/null)
  if [ -n "$ORDER_ID" ]; then ok "order created: $ORDER_ID"; else no "order failed: $ORDER"; fi
fi

info "waiting 10s for the async chain and the span batch..."
sleep 10

#6. propagation
step "6. One trace ID across all three services"
LOGS=$(docker compose logs --since 90s order-service payment-service notification-service 2>/dev/null)
tid() { echo "$LOGS" | grep -m1 "$1" | grep -o '"traceId":"[a-f0-9]\{32\}"' | cut -d'"' -f4; }
T_ORDER=$(tid order_created_event_published)
T_PAY=$(tid payment_completed_event_published)
T_NOTIF=$(tid notification_sent)
info "order=${T_ORDER:-<none>}  payment=${T_PAY:-<none>}  notification=${T_NOTIF:-<none>}"
if [ -n "$T_ORDER" ] && [ "$T_ORDER" = "$T_PAY" ] && [ "$T_PAY" = "$T_NOTIF" ]; then
  ok "propagation intact across two broker hops"
else
  no "trace IDs differ or missing — propagation broken"
fi

#7. in Tempo
step "7. Trace queryable in Tempo with the full chain"
if [ -n "${T_ORDER:-}" ]; then
  svcs=$(curl -s "$TEMPO/api/traces/$T_ORDER" | python3 -c '
import sys,json
try: d=json.load(sys.stdin)
except Exception: print(""); raise SystemExit
names=set()
for b in d.get("batches",[]):
    for a in b.get("resource",{}).get("attributes",[]):
        if a["key"]=="service.name":
            names.add(a["value"].get("stringValue",""))
print(",".join(sorted(names)))' 2>/dev/null)
  case "$svcs" in
    *order-service*payment-service*|*payment-service*order-service*)
      case "$svcs" in
        *notification-service*) ok "Tempo has the full chain: $svcs" ;;
        *) no "notification-service missing from: $svcs" ;;
      esac ;;
    *) no "Tempo returned: ${svcs:-<nothing>} (spans may still be exporting)" ;;
  esac
else
  no "skipped — no trace id from step 6"
fi

#8. in Loki
step "8. Log line carries that trace ID as structured metadata"
if [ -n "${T_ORDER:-}" ]; then
  start=$(( ($(date +%s) - 600) * 1000000000 ))
  hits=$(curl -s -G "$LOKI/loki/api/v1/query_range" \
        --data-urlencode "query={log_type=\"application\"} | trace_id = \"$T_ORDER\"" \
        --data-urlencode "start=$start" --data-urlencode "limit=20" \
        | python3 -c 'import sys,json
try: print(len(json.load(sys.stdin)["data"]["result"]))
except Exception: print(0)' 2>/dev/null)
  if [ "${hits:-0}" -gt 0 ]; then
    ok "$hits stream(s) match on the trace_id label — derived field will resolve"
  else
    no "no logs found — check Alloy stage.structured_metadata"
  fi
else
  no "skipped"
fi

#9. no zero trace ids
step "9. No all-zero trace IDs in logs"
zeros=$(echo "$LOGS" | grep -c '"traceId":"0\{32\}"')
if [ "${zeros:-0}" -eq 0 ]; then
  ok "isSpanContextValid() guard holding"
else
  no "$zeros lines with an invalid trace id"
fi

#10. no orphan health-check traces
step "10. Health checks are not creating orphan traces"
# rootName, not name: nested pg-pool.connect spans inside real traces are
# healthy and must not be counted as orphans.
orphans=$(curl -s -G "$TEMPO/api/search" \
  --data-urlencode 'q={ rootName = "pg-pool.connect" }' --data-urlencode 'limit=20' \
  | python3 -c 'import sys,json
try: print(len(json.load(sys.stdin).get("traces") or []))
except Exception: print(0)' 2>/dev/null)
if [ "${orphans:-0}" -le 5 ]; then
  ok "$orphans root pg-pool.connect traces (startup only, expected)"
else
  no "$orphans orphan traces — withoutTracing() may not be applied"
fi

# 11. graceful shutdown
step "11. Graceful shutdown flushes spans"
docker compose stop order-service >/dev/null 2>&1
sleep 4
SD=$(docker compose logs --tail 60 order-service 2>/dev/null)
app_line=$(echo "$SD" | grep -n 'service_shutting_down' | head -1 | cut -d: -f1)
sdk_line=$(echo "$SD" | grep -n 'opentelemetry_shutdown_complete' | head -1 | cut -d: -f1)
info "app shutdown at line ${app_line:-none}, sdk flush at line ${sdk_line:-none}"
if [ -n "$app_line" ] && [ -n "$sdk_line" ] && [ "$app_line" -lt "$sdk_line" ]; then
  ok "both ran, app first then SDK flush — shutdown race is fixed"
elif [ -n "$app_line" ] && [ -n "$sdk_line" ]; then
  no "both present but SDK flushed first — ordering is luck, not design"
else
  no "missing one of the two — spans are still dropped on deploy"
fi
docker compose start order-service >/dev/null 2>&1
info "order-service restarted"

# 12. induced failure (opt-in)
if [ "$WITH_FAILURE" -eq 1 ]; then
  step "12. Induced failure: postgres down"
  docker compose stop postgres >/dev/null 2>&1
  info "postgres stopped; generating traffic so the error ratio has a denominator..."
  for i in 1 2 3 4 5 6 7 8 9 10; do
    curl -s -o /dev/null http://localhost:3001/users
    curl -s -o /dev/null http://localhost:3002/products
  done
  sleep 45

  code=$(curl -s --max-time 10 -o /dev/null -w '%{http_code}' http://localhost:3001/health)
  if [ "$code" = "503" ]; then ok "user-service /health -> 503"; else no "expected 503, got $code"; fi

  firing=$(curl -s "$PROM/api/v1/alerts" | python3 -c 'import sys,json
try:
    a=json.load(sys.stdin)["data"]["alerts"]
    print(" ".join(sorted(set(x["labels"].get("alertname","?") for x in a))))
except Exception: print("")' 2>/dev/null)
  info "active alerts: ${firing:-<none>}"
  # UI-only alerting: this asserts the rule reaches firing/pending state in
  # Prometheus, not that a notification was delivered. There is no
  # Alertmanager wired up.
  if [ -n "$firing" ]; then ok "alert rules reacted (state visible in UI)"; else no "no alerts became active"; fi

  docker compose start postgres >/dev/null 2>&1
  info "postgres restarted; waiting 60s for recovery..."
  sleep 60
  code=$(curl -s --max-time 10 -o /dev/null -w '%{http_code}' http://localhost:3001/health)
  if [ "$code" = "200" ]; then ok "recovered within 60s"; else no "still $code after 60s"; fi
else
  step "12. Induced failure — skipped (pass --with-failure to run)"
fi

# result
printf '\n\033[1m%d passed, %d failed\033[0m\n' "$pass" "$fail"
[ "$fail" -eq 0 ] || exit 1