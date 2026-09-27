#!/usr/bin/env bash
#
# argocd-bootstrap.sh — bring Argo CD up and hand the cluster over to git.
#
# Run the steps IN ORDER. Each one checks the previous one happened.
#
#   ./scripts/argocd-bootstrap.sh preflight   will it fit? (requests, not usage)
#   ./scripts/argocd-bootstrap.sh install     Argo CD + the Sealed Secrets controller
#   ./scripts/argocd-bootstrap.sh seal        encrypt secret.yaml into a SealedSecret
#   ./scripts/argocd-bootstrap.sh root        hand everything to the app-of-apps
#   ./scripts/argocd-bootstrap.sh status      what Argo CD thinks of each app
#   ./scripts/argocd-bootstrap.sh ui          port-forward the UI and print the login
#
# Why the order is fixed — a genuine chicken-and-egg:
#   · the app needs its Secret, which must be a SealedSecret to live in git
#   · sealing needs the controller's public key, so the controller must run first
#   · the controller is installed BY Argo CD
# So: install Argo CD and ONLY the sealed-secrets Application, seal, push,
# then apply the root app, which adopts sealed-secrets and adds the rest.
#
# Written for bash 3.2.

set -uo pipefail

ARGOCD_CHART_VERSION=10.9.2          # Argo CD v3.5.3
GITOPS=infra/k8s/gitops
SECRET_PLAIN=infra/k8s/base/config/secret.yaml
SECRET_SEALED=infra/k8s/base/config/sealed-secret.yaml
BRANCH=features/develop

step() { printf '\n\033[1m%s\033[0m\n' "$*"; }
ok()   { printf '  \033[32m✓\033[0m %s\n' "$*"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$*"; }
die()  { printf '  \033[31m✗\033[0m %s\n' "$*"; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || die "$1 not found — brew install $2"; }

kubectl --request-timeout=10s get --raw /readyz >/dev/null 2>&1 \
  || die "API server not responding — is the k3d cluster up?"

wait_app_healthy() {   # name, timeout-seconds
  printf '  waiting for %s' "$1"
  for _ in $(seq 1 $(( $2 / 5 ))); do
    h=$(kubectl -n argocd get application "$1" -o jsonpath='{.status.health.status}' 2>/dev/null)
    s=$(kubectl -n argocd get application "$1" -o jsonpath='{.status.sync.status}' 2>/dev/null)
    if [ "$h" = "Healthy" ] && [ "$s" = "Synced" ]; then printf '\n'; ok "$1 Synced + Healthy"; return 0; fi
    printf '.'; sleep 5
  done
  printf '\n'; warn "$1 is ${s:-?}/${h:-?} after $2s — see: ./scripts/argocd-bootstrap.sh status"
  return 1
}

#  preflight
preflight() {
  step "Preflight — node capacity by REQUESTS"
  # The scheduler places pods by requested memory, not measured usage. The
  # app uses ~1.3GB but requests considerably more; this is the number that
  # decides whether Argo CD's pods schedule or sit Pending.
  kubectl describe nodes | awk '
    /Allocatable:/ {a=1} a && /memory:/ && !am {print "  allocatable memory:   " $2; am=1}
    /Allocated resources:/ {r=1}
    r && /memory/ && !rm {print "  already requested:    " $2 " " $3; rm=1}'
  printf '  argo cd will request: ~480Mi  (+64Mi sealed-secrets)\n'
  printf '\n  If "already requested" plus ~550Mi exceeds allocatable, Argo CD pods\n'
  printf '  will be Pending with "Insufficient memory" even though kubectl top\n'
  printf '  shows the node half empty. Lower the largest request first —\n'
  printf '  rabbitmq asks for 1Gi and uses far less.\n'
  kubectl top node 2>/dev/null | sed 's/^/  /'
}

#  install
install() {
  need helm helm
  step "1. Argo CD (chart $ARGOCD_CHART_VERSION)"
  helm repo add argo https://argoproj.github.io/argo-helm >/dev/null 2>&1
  helm repo update argo >/dev/null
  # upgrade --install is idempotent: re-running this step is safe.
  helm upgrade --install argocd argo/argo-cd \
    --version "$ARGOCD_CHART_VERSION" \
    --namespace argocd --create-namespace \
    --values "$GITOPS/argocd/values.yaml" \
    --wait --timeout 10m \
    || die "helm install failed — kubectl -n argocd get pods"
  ok "Argo CD running"
  kubectl -n argocd get pods

  step "2. Sealed Secrets controller (via Argo CD, not helm)"
  # Only this one Application for now — NOT the root app. The root app would
  # also create rootsmarket, which cannot sync until its SealedSecret exists.
  kubectl apply -f "$GITOPS/applications/sealed-secrets.yaml" >/dev/null \
    || die "could not create the sealed-secrets Application"
  wait_app_healthy sealed-secrets 300 || exit 1

  step "3. Back up the sealing key — do this now"
  printf '  This key is not in git. Lose it and every SealedSecret in the repo\n'
  printf '  is permanently undecryptable. Store the file in a password manager:\n\n'
  printf '    kubectl -n kube-system get secret \\\n'
  printf '      -l sealedsecrets.bitnami.com/sealed-secrets-key \\\n'
  printf '      -o yaml > ~/sealed-secrets-key.rootsmarket.yaml\n\n'
  printf '  Next:  ./scripts/argocd-bootstrap.sh seal\n'
}

# seal
seal() {
  need kubeseal kubeseal
  step "Seal the app secret"
  [ -f "$SECRET_PLAIN" ] || die "no $SECRET_PLAIN to seal"
  grep -q "CHANGE_ME" "$SECRET_PLAIN" && die "$SECRET_PLAIN still has CHANGE_ME placeholders"

  # The plaintext must never reach GitHub.
  if git ls-files --error-unmatch "$SECRET_PLAIN" >/dev/null 2>&1; then
    warn "$SECRET_PLAIN IS TRACKED BY GIT"
    printf '    If it was ever pushed, treat those passwords as compromised and\n'
    printf '    rotate them. Then stop tracking it:\n'
    printf '      git rm --cached %s\n' "$SECRET_PLAIN"
  fi
  grep -qxF "$SECRET_PLAIN" .gitignore 2>/dev/null || {
    echo "$SECRET_PLAIN" >> .gitignore; ok "added $SECRET_PLAIN to .gitignore"; }

  # Strict scope (the default): the SealedSecret only decrypts under this exact
  # name AND namespace. Copying it elsewhere yields nothing — by design.
  kubeseal --format yaml < "$SECRET_PLAIN" > "$SECRET_SEALED" \
    || die "kubeseal failed — is the controller running? kubectl -n kube-system get pods"
  ok "wrote $SECRET_SEALED (safe to commit)"

  # The Secret already exists, created by kubectl earlier. The controller
  # refuses to overwrite a Secret it did not create; this annotation lets it
  # adopt the existing one in place, with no gap where the Secret is missing.
  kubectl -n rootsmarket annotate secret rootsmarket-secrets \
    sealedsecrets.bitnami.com/managed=true --overwrite >/dev/null 2>&1 \
    && ok "existing Secret marked for adoption by the controller"

  cat <<NEXT

  Now, by hand:
    1. In infra/k8s/base/config/kustomization.yaml, replace
           - secret.yaml
       with
           - sealed-secret.yaml
    2. Check it renders:   kubectl kustomize infra/k8s/overlays/local >/dev/null && echo ok
    3. Commit and PUSH:    git add -A && git commit -m "feat(gitops): seal app secret" && git push
    4. Then:               ./scripts/argocd-bootstrap.sh root
NEXT
}

# root
root() {
  step "Hand the cluster to git"
  [ -f "$SECRET_SEALED" ] || die "no $SECRET_SEALED — run 'seal' first"
  grep -q "sealed-secret.yaml" infra/k8s/base/config/kustomization.yaml \
    || die "base/config/kustomization.yaml still references secret.yaml — see the 'seal' output"
  git ls-files --error-unmatch "$SECRET_SEALED" >/dev/null 2>&1 \
    || die "$SECRET_SEALED is not committed"

  # Argo CD reads GitHub. If the push has not happened, it will sync the OLD
  # tree — still referencing secret.yaml, which is not in git — and fail.
  git fetch -q origin "$BRANCH" 2>/dev/null
  local_h=$(git rev-parse HEAD)
  remote_h=$(git rev-parse "origin/$BRANCH" 2>/dev/null || echo none)
  if [ "$local_h" != "$remote_h" ]; then
    die "local HEAD is not what GitHub has on $BRANCH — git push first
    Argo CD syncs from the remote. An unpushed commit does not exist to it."
  fi
  ok "GitHub has $BRANCH at ${local_h:0:8}"

  kubectl apply -f "$GITOPS/root-app.yaml" >/dev/null || die "could not create the root Application"
  ok "root Application created — it adopts sealed-secrets and adds rootsmarket"
  wait_app_healthy root 180
  wait_app_healthy rootsmarket 420

  cat <<DONE

  From here on, the cluster is git. To change anything:
    edit → commit → push → Argo CD syncs (or force it: kubectl -n argocd
    annotate application rootsmarket argocd.argoproj.io/refresh=hard --overwrite)

  kubectl apply against the rootsmarket namespace will be REVERTED — selfHeal.
  Only images still come from ./scripts/k8s-k3d.sh images.
DONE
}

# status
status() {
  step "Argo CD Applications"
  kubectl -n argocd get applications \
    -o custom-columns='APP:.metadata.name,WAVE:.metadata.annotations.argocd\.argoproj\.io/sync-wave,SYNC:.status.sync.status,HEALTH:.status.health.status,REVISION:.status.sync.revision' \
    2>/dev/null || die "no Applications — run install first"
  # Surface the reason for anything not green, which the table hides.
  kubectl -n argocd get applications -o json | python3 -c '
import sys, json
for a in json.load(sys.stdin)["items"]:
    st = a.get("status", {})
    for c in st.get("conditions", []) or []:
        print("  " + a["metadata"]["name"] + ": " + c.get("type", "") + " — " + c.get("message", "")[:160])
    op = (st.get("operationState") or {})
    if op.get("phase") in ("Failed", "Error"):
        print("  " + a["metadata"]["name"] + ": last sync " + op["phase"] + " — " + op.get("message", "")[:160])'
}

# ui
ui() {
  pw=$(kubectl -n argocd get secret argocd-initial-admin-secret \
         -o jsonpath='{.data.password}' 2>/dev/null | base64 -d)
  printf '\n  URL:      http://localhost:8081\n  user:     admin\n  password: %s\n\n' "${pw:-<initial secret already deleted>}"
  printf '  Change it, then delete the initial secret:\n'
  printf '    kubectl -n argocd delete secret argocd-initial-admin-secret\n\n'
  printf '  (8081, not 8080 — 8080 is k3d'\''s NodePort mapping)\n'
  kubectl -n argocd port-forward svc/argocd-server 8081:80
}

case "${1:-}" in
  preflight) preflight ;;
  install)   install ;;
  seal)      seal ;;
  root)      root ;;
  status)    status ;;
  ui)        ui ;;
  *) sed -n '3,12p' "$0"; exit 1 ;;
esac