#!/usr/bin/env bash
#
# k8s-bootstrap.sh — create the cluster, build and load images, apply manifests.
#
#   ./scripts/k8s-bootstrap.sh            full run
#   ./scripts/k8s-bootstrap.sh images     rebuild and reload images only
#   ./scripts/k8s-bootstrap.sh apply      re-apply manifests, one component at a time
#   ./scripts/k8s-bootstrap.sh status     show what is running
#   ./scripts/k8s-bootstrap.sh destroy    delete the cluster
#
# Defaults to k3d. For kind:  CLUSTER_TOOL=kind ./scripts/k8s-bootstrap.sh
#
# Written for bash 3.2 (the version macOS ships) — no associative arrays.

set -uo pipefail

CLUSTER_TOOL=${CLUSTER_TOOL:-k3d}
CLUSTER=rootsmarket
NS=rootsmarket
K8S_DIR=infra/k8s
OVERLAY="$K8S_DIR/overlays/local"

SERVICES="user-service product-service order-service payment-service notification-service"

# Apply order. Not a dependency order Kubernetes enforces — it does not — but
# applying 28 objects in one request is what made etcd time out on kind.
# Component by component keeps each transaction small.
COMPONENTS="namespaces config db cache messaging backend frontend"

case "$CLUSTER_TOOL" in
  k3d)  CONTEXT="k3d-$CLUSTER";  CLUSTER_CONFIG="$K8S_DIR/cluster/k3d-cluster.yaml" ;;
  kind) CONTEXT="kind-$CLUSTER"; CLUSTER_CONFIG="$K8S_DIR/cluster/kind-cluster.yaml" ;;
  *)    printf 'unknown CLUSTER_TOOL: %s (k3d | kind)\n' "$CLUSTER_TOOL"; exit 1 ;;
esac

step() { printf '\n\033[1m%s\033[0m\n' "$*"; }
ok()   { printf '  \033[32m✓\033[0m %s\n' "$*"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$*"; }
die()  { printf '  \033[31m✗\033[0m %s\n' "$*"; exit 1; }

need() { command -v "$1" >/dev/null 2>&1 || die "$1 not found${2:+ — $2}"; }

# Docker Desktop's socket is a proxy to a daemon inside a VM. When the VM
# loses its route, every call returns 500 with an empty body and image loads
# retry forever. Fail fast instead.
check_docker() {
  docker version --format '{{.Server.Version}}' >/dev/null 2>&1 && return 0
  die "Docker daemon unreachable. Check:
      tail -20 ~/Library/Containers/com.docker.docker/Data/log/host/com.docker.backend.log
    'still dialing ... no route to host' means the VM is unreachable —
    quit Docker Desktop, pkill -f com.docker.backend, reopen. Reboot if that fails."
}

# kubectl can hang for a full TLS timeout when the API server is starved.
# Probe it once, briefly, before doing anything that depends on it.
check_api() {
  kubectl --context "$CONTEXT" --request-timeout=10s get --raw /readyz >/dev/null 2>&1 && return 0
  die "API server not responding. On a memory-starved node this is the
    control plane losing CPU. Check:
      docker stats --no-stream
    and consider scaling the backend to zero:
      kubectl -n $NS scale deploy --all --replicas=0"
}

cluster_exists() {
  case "$CLUSTER_TOOL" in
    k3d)  k3d cluster list 2>/dev/null | awk 'NR>1 {print $1}' | grep -qx "$CLUSTER" ;;
    kind) kind get clusters 2>/dev/null | grep -qx "$CLUSTER" ;;
  esac
}

create_cluster() {
  step "1. Cluster ($CLUSTER_TOOL)"
  if cluster_exists; then
    ok "cluster '$CLUSTER' already exists"
  else
    # The compose stack and a Kubernetes copy of it will not both fit.
    if docker ps --format '{{.Names}}' | grep -q '^rootsmarket-[a-z]*-service$'; then
      warn "compose stack is running — stop it first:  docker compose down"
      exit 1
    fi
    case "$CLUSTER_TOOL" in
      k3d)  k3d cluster create --config "$CLUSTER_CONFIG" ;;
      kind) kind create cluster --config "$CLUSTER_CONFIG" ;;
    esac || die "cluster creation failed"
    ok "cluster created"
  fi
  kubectl config use-context "$CONTEXT" >/dev/null 2>&1 || die "no kubeconfig context $CONTEXT"
  kubectl get nodes
}

build_images() {
  step "2. Build images"
  IMAGES=""
  for svc in $SERVICES; do
    docker build -q -f "services/$svc/Dockerfile" -t "rootsmarket/$svc:dev" . >/dev/null \
      || die "build failed: $svc"
    ok "built rootsmarket/$svc:dev"
    IMAGES="$IMAGES rootsmarket/$svc:dev"
  done

  if [ -d frontend ]; then
    docker build -q -t rootsmarket/frontend:dev ./frontend >/dev/null \
      || die "build failed: frontend"
    ok "built rootsmarket/frontend:dev"
    IMAGES="$IMAGES rootsmarket/frontend:dev"
  fi

  step "3. Load into cluster"
  # Output deliberately NOT suppressed. Silence here was indistinguishable
  # from a hang when the Docker VM lost its route.
  case "$CLUSTER_TOOL" in
    k3d)
      # One call, all images. k3d bundles them into a single tarball and
      # imports once, rather than once per image.
      # shellcheck disable=SC2086
      k3d image import $IMAGES -c "$CLUSTER" || die "image import failed"
      ;;
    kind)
      for img in $IMAGES; do
        kind load docker-image "$img" --name "$CLUSTER" || die "load failed: $img"
      done
      ;;
  esac
  ok "images loaded"

  verify_images
}

# Ask the kubelet what it actually has, rather than trusting the loader's
# exit code. The kubelet's image list lags by a status interval, so a count
# one short immediately after loading is usually not a real miss.
verify_images() {
  kubectl get nodes -o json | python3 -c '
import sys, json
for n in json.load(sys.stdin)["items"]:
    imgs = sorted({t.split("/")[-1] for i in n["status"].get("images", [])
                   for t in (i.get("names") or []) if "rootsmarket/" in t and ":" in t})
    name = n["metadata"]["name"]
    print("  " + name + ": " + str(len(imgs)) + " images")
    for i in imgs: print("      " + i)'
}

apply_manifests() {
  step "4. Apply manifests"
  [ -f "$K8S_DIR/base/config/secret.yaml" ] \
    || die "no base/config/secret.yaml — fill in the passwords first"
  grep -q "CHANGE_ME" "$K8S_DIR/base/config/secret.yaml" 2>/dev/null \
    && warn "secret.yaml still contains CHANGE_ME placeholders"

  # Render the whole overlay first. A kustomize error here is far easier to
  # read than the same error arriving through kubectl mid-apply.
  kubectl kustomize "$OVERLAY" >/dev/null || die "kustomize build failed"
  ok "overlay renders"

  check_api

  # Then apply component by component. Each folder under base/ has its own
  # kustomization, so each is independently applicable — that was the point
  # of the split.
  for c in $COMPONENTS; do
    kubectl apply -k "$K8S_DIR/base/$c" >/dev/null || die "apply failed: $c"
    ok "applied $c"
    sleep 2
  done

  # Finally the overlay, which only patches what base already created
  # (replica counts, debug logging). Cheap, and it is the source of truth.
  kubectl apply -k "$OVERLAY" >/dev/null || die "overlay apply failed"
  ok "applied overlay"
}

wait_ready() {
  step "5. Wait for rollout"
  # Data layer first. Readiness probes on the services hit /health, which
  # checks these — waiting on services first means watching them sit 0/1.
  kubectl -n "$NS" rollout status statefulset/postgres --timeout=180s >/dev/null 2>&1 && ok "postgres"
  kubectl -n "$NS" rollout status deployment/redis     --timeout=120s >/dev/null 2>&1 && ok "redis"
  # RabbitMQ boots in ~90s and its startupProbe budget covers that.
  kubectl -n "$NS" rollout status statefulset/rabbitmq --timeout=300s >/dev/null 2>&1 && ok "rabbitmq"

  for svc in $SERVICES; do
    kubectl -n "$NS" rollout status "deployment/$svc" --timeout=180s >/dev/null 2>&1 \
      && ok "$svc" || warn "$svc not ready yet"
  done
  [ -d frontend ] && kubectl -n "$NS" rollout status deployment/frontend --timeout=120s >/dev/null 2>&1 \
    && ok "frontend"
}

summary() {
  step "6. State"
  kubectl -n "$NS" get pods -o wide

  bad=$(kubectl -n "$NS" get pods --no-headers 2>/dev/null \
        | awk '$3 != "Running" && $3 != "Completed" {print "    " $1 "  " $3}')
  if [ -n "$bad" ]; then
    printf '\n\033[31m  not running:\033[0m\n%s\n' "$bad"
    printf '\n  Diagnose with:\n'
    printf '    kubectl -n %s describe pod <name> | tail -25   # Events first\n' "$NS"
    printf '    kubectl -n %s logs <name> --previous           # if it restarted\n' "$NS"
  fi

  # k3s ships metrics-server, so this works here where it did not on kind.
  if kubectl top nodes >/dev/null 2>&1; then
    printf '\n'; kubectl top nodes
  fi

  cat <<TIP

  Reach a service:        kubectl -n $NS port-forward svc/user-service 3001:3001
  Watch pods settle:      kubectl -n $NS get pods -w
  Resource pressure:      kubectl top pods -n $NS
  After a code change:    ./scripts/k8s-bootstrap.sh images
                          kubectl -n $NS rollout restart deployment/<service>

TIP
}

destroy() {
  step "Destroy cluster ($CLUSTER_TOOL)"
  case "$CLUSTER_TOOL" in
    k3d)  k3d cluster delete "$CLUSTER" ;;
    kind) kind delete cluster --name "$CLUSTER" ;;
  esac
}

need docker; need kubectl; need python3
need "$CLUSTER_TOOL" "brew install $CLUSTER_TOOL"
check_docker

case "${1:-all}" in
  images)  build_images ;;
  apply)   apply_manifests; wait_ready; summary ;;
  status)  check_api; verify_images; summary ;;
  destroy) destroy ;;
  all)     create_cluster; build_images; apply_manifests; wait_ready; summary ;;
  *)       die "unknown command: $1  (images | apply | status | destroy | all)" ;;
esac