#!/usr/bin/env bash
#
# k8s-bootstrap.sh — create the cluster, build and load images, apply manifests.
#
#   ./scripts/k8s-bootstrap.sh            full run
#   ./scripts/k8s-bootstrap.sh images     rebuild and reload images only
#   ./scripts/k8s-bootstrap.sh apply      re-apply manifests only
#   ./scripts/k8s-bootstrap.sh status     show what is running
#
# Written for bash 3.2 (the version macOS ships) — no associative arrays.

set -uo pipefail

CLUSTER=rootsmarket
NS=rootsmarket
K8S_DIR=infra/k8s
OVERLAY="$K8S_DIR/overlays/local"

SERVICES="user-service product-service order-service payment-service notification-service"

# kind has no registry, so images are side-loaded onto each node. The
# control-plane carries a NoSchedule taint and will never run these pods, so
# loading there is a third of the work wasted.
WORKERS="$CLUSTER-control-plane"

step() { printf '\n\033[1m%s\033[0m\n' "$*"; }
ok()   { printf '  \033[32m✓\033[0m %s\n' "$*"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$*"; }
die()  { printf '  \033[31m✗\033[0m %s\n' "$*"; exit 1; }

need() { command -v "$1" >/dev/null 2>&1 || die "$1 not found"; }

# Docker Desktop's socket is a proxy to a daemon inside a VM. When the VM
# loses its route, every call returns 500 with an empty body and `kind load`
# retries forever. Fail fast with a useful message instead.
check_docker() {
  docker version --format '{{.Server.Version}}' >/dev/null 2>&1 && return 0
  die "Docker daemon unreachable. Check:
      tail -20 ~/Library/Containers/com.docker.docker/Data/log/host/com.docker.backend.log
    'still dialing ... no route to host' means the VM is unreachable —
    quit Docker Desktop, pkill -f com.docker.backend, reopen. Reboot if that fails."
}

create_cluster() {
  step "1. Cluster"
  if kind get clusters 2>/dev/null | grep -qx "$CLUSTER"; then
    ok "cluster '$CLUSTER' already exists"
  else
    # The compose stack and a Kubernetes copy of it will not both fit.
    if docker ps --format '{{.Names}}' | grep -q '^rootsmarket-[a-z]*-service'; then
      warn "compose stack is running — stop it first:  docker compose down"
      exit 1
    fi
    kind create cluster --config "$K8S_DIR/cluster/kind-cluster.yaml" \
      || die "cluster creation failed"
    ok "cluster created"
  fi
  kubectl config use-context "kind-$CLUSTER" >/dev/null 2>&1
  kubectl get nodes
}

build_images() {
  step "2. Build images"
  for svc in $SERVICES; do
    docker build -q -f "services/$svc/Dockerfile" -t "rootsmarket/$svc:dev" . >/dev/null \
      || die "build failed: $svc"
    ok "built rootsmarket/$svc:dev"
  done

  if [ -d frontend ]; then
    docker build -q -t rootsmarket/frontend:dev ./frontend >/dev/null \
      || die "build failed: frontend"
    ok "built rootsmarket/frontend:dev"
  fi

  step "3. Side-load onto workers"
  # Output is NOT suppressed. Loading is slow — a few hundred MB per image per
  # node — and silence here is indistinguishable from a hang, which is exactly
  # what happened when the Docker VM lost its route.
  for svc in $SERVICES; do
    kind load docker-image "rootsmarket/$svc:dev" \
      --name "$CLUSTER" --nodes "$WORKERS" \
      || die "load failed: $svc"
    ok "loaded $svc"
  done

  if [ -d frontend ]; then
    kind load docker-image rootsmarket/frontend:dev \
      --name "$CLUSTER" --nodes "$WORKERS" \
      || die "load failed: frontend"
    ok "loaded frontend"
  fi

  verify_images
}

# Ask the kubelet what it actually has, rather than trusting that the load
# reported success.
verify_images() {
  kubectl get nodes -o json | python3 -c '
import sys, json
for n in json.load(sys.stdin)["items"]:
    name = n["metadata"]["name"]
    imgs = [t for i in n["status"].get("images", [])
              for t in (i.get("names") or []) if "rootsmarket/" in t]
    mark = "\033[32m✓\033[0m" if (imgs or "control-plane" in name) else "\033[31m✗\033[0m"
    print(f"  {mark} {name}: {len(imgs)} rootsmarket images")'
}

apply_manifests() {
  step "4. Apply manifests"
  [ -f "$K8S_DIR/base/config/secret.yaml" ] \
    || die "no base/config/secret.yaml — fill in the passwords first"

  grep -q "CHANGE_ME" "$K8S_DIR/base/config/secret.yaml" 2>/dev/null \
    && warn "secret.yaml still contains CHANGE_ME placeholders"

  # Render first. A kustomize error here is far easier to read than the same
  # error arriving through kubectl.
  kubectl kustomize "$OVERLAY" >/dev/null || die "kustomize build failed"

  # Idempotent — safe to re-run after any edit. Kubernetes reconciles the
  # difference; there is no --force-recreate.
  kubectl apply -k "$OVERLAY" || die "apply failed"
  ok "applied $OVERLAY"
}

wait_ready() {
  step "5. Wait for rollout"
  # Data layer first. Service readiness probes hit /health, which checks
  # Postgres — waiting on services before the database is ready means
  # watching them sit 0/1 for no reason.
  kubectl -n "$NS" rollout status statefulset/postgres --timeout=180s 2>/dev/null && ok "postgres"
  kubectl -n "$NS" rollout status deployment/redis     --timeout=120s 2>/dev/null && ok "redis"
  # RabbitMQ boots in ~90s; the startupProbe covers it, so allow for that here.
  kubectl -n "$NS" rollout status statefulset/rabbitmq --timeout=300s 2>/dev/null && ok "rabbitmq"

  for svc in $SERVICES; do
    kubectl -n "$NS" rollout status "deployment/$svc" --timeout=180s 2>/dev/null \
      && ok "$svc" || warn "$svc did not become ready — see 'describe pod' below"
  done

  [ -d frontend ] && kubectl -n "$NS" rollout status deployment/frontend --timeout=120s 2>/dev/null \
    && ok "frontend"
}

summary() {
  step "6. State"
  kubectl -n "$NS" get pods -o wide
  printf '\n'
  kubectl -n "$NS" get svc

  # Surface anything unhealthy without being asked.
  bad=$(kubectl -n "$NS" get pods --no-headers 2>/dev/null \
        | awk '$3 != "Running" && $3 != "Completed" {print "    " $1 "  " $3}')
  if [ -n "$bad" ]; then
    printf '\n\033[31m  not running:\033[0m\n%s\n' "$bad"
    printf '\n  Diagnose with:\n'
    printf '    kubectl -n %s describe pod <name>     # Events, at the bottom\n' "$NS"
    printf '    kubectl -n %s logs <name> --previous  # if it restarted\n' "$NS"
  fi

  cat <<TIP

  Reach a service without an Ingress:
      kubectl -n $NS port-forward svc/user-service 3001:3001

  Watch pods settle:
      kubectl -n $NS get pods -w

  Re-apply after editing a manifest:
      ./scripts/k8s-bootstrap.sh apply

  Rebuild and reload after a code change:
      ./scripts/k8s-bootstrap.sh images
      kubectl -n $NS rollout restart deployment/<service>

TIP
}

need docker; need kind; need kubectl; need python3
check_docker

case "${1:-all}" in
  images) build_images ;;
  apply)  apply_manifests; wait_ready; summary ;;
  status) verify_images; summary ;;
  all)    create_cluster; build_images; apply_manifests; wait_ready; summary ;;
  *)      die "unknown command: $1  (images | apply | status | all)" ;;
esac