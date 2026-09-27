# RootsMarket on Kubernetes

The same five services, the same images, deployed to a cluster and managed by
Argo CD. Nothing in the application code changed — the OpenTelemetry
instrumentation and the RabbitMQ trace-propagation helper read their
configuration from the environment and do not know what is running them.

What did change is everything around the process: healthchecks became probes,
`mem_limit` became requests and limits, `depends_on` became readiness gates,
and `kubectl apply` became a git push.

## Layout

```
infra/k8s/
├── cluster/
│   ├── k3d-cluster.yaml          local cluster (current)
│   └── kind-cluster.yaml         kept for reference — see "Why k3d"
├── base/                         one folder per component, each independently
│   ├── namespaces/               applicable: kubectl apply -k base/db
│   ├── config/                   ConfigMap + SealedSecret
│   ├── db/                       postgres StatefulSet, PVC, generated init SQL
│   ├── cache/                    redis Deployment (no PVC — it is a cache)
│   ├── messaging/                rabbitmq StatefulSet + PVC
│   ├── backend/                  the five Node services
│   └── frontend/
├── overlays/
│   ├── local/                    1 replica, debug logging, trimmed requests
│   └── staging/                  2 replicas, 10% trace sampling
└── gitops/
    ├── argocd/values.yaml        the one Helm install in the project
    ├── root-app.yaml             app-of-apps
    └── applications/             one file per component Argo CD manages
```

Component folders each carry their own `kustomization.yaml`, so the data layer
can be brought up and verified before the services that probe it exist. The
same property lets Argo CD sync them as separate Applications with sync waves.

## Running it

```bash
brew install k3d kubectl helm kubeseal

./scripts/k8s-bootstrap.sh          # cluster, build+import images, apply
./scripts/e2e-k8s.sh                # 12 checks
./scripts/e2e-k8s.sh --with-failure # 17 checks, including an induced outage
```

Then hand the cluster to git:

```bash
./scripts/argocd-bootstrap.sh preflight   # will it fit? (requests, not usage)
./scripts/argocd-bootstrap.sh install     # Argo CD + Sealed Secrets controller
./scripts/argocd-bootstrap.sh seal        # encrypt secret.yaml for git
#   swap secret.yaml → sealed-secret.yaml in base/config/kustomization.yaml
#   commit and PUSH — Argo CD reads GitHub, not your working tree
./scripts/argocd-bootstrap.sh root        # app-of-apps takes over
./scripts/argocd-bootstrap.sh ui          # localhost:8081
```

**After `root`, stop using kubectl to change things.** `selfHeal` reverts
manual edits within minutes. Scale a Deployment by hand and Argo CD scales it
back, because git says otherwise. Images are the exception: Argo CD deploys
manifests, it does not build anything, so new images still come from
`./scripts/k8s-bootstrap.sh images`.

## The three probes

The single most useful idea carried over from the Docker Compose phase, where
the same distinction had been reached from a different direction: a service
whose database is down should report the problem, not exit.

| Probe | Question | Failure means | Checks dependencies? |
|---|---|---|---|
| startup | did the process bind its port? | kill and restart | **no** |
| liveness | is it wedged? | kill and restart | **no** |
| readiness | can it serve right now? | remove from the Service | **yes** |

Two mistakes this project made and fixed:

**`httpGet /health` as a startup probe.** `/health` returns 503 while Postgres
is still coming up, so the container was killed before it ever started — a
crash loop in Kubernetes clothing. Startup asks whether the process is
listening: `tcpSocket`.

**Default liveness timings on a loaded node.** When the node stalls, probes
time out, the kubelet kills healthy processes, and each restart adds startup
load — making the next timeout more likely. It killed a Node service,
Argo CD's server and its repo-server on the same day. Liveness should be the
most forgiving probe you have; readiness can stay tight, because being removed
from a Service is cheap and reversible.

Verified by `./scripts/e2e-k8s.sh --with-failure`: Postgres is scaled to zero,
services return 503, readiness removes them from their Services, **no pod
restarts**, and everything recovers unaided when it comes back.

## Requests and limits

The scheduler reserves **requests**. Limits only cap. Getting this backwards
produces two opposite failures, and this project hit both:

| | Symptom | Cause |
|---|---|---|
| Limit too low | OOMKilled, exit 137, no shutdown log, no span flush | SIGKILL cannot be trapped |
| Request too high | Pods Pending, "Insufficient memory", node idle | requests are reserved whether used or not |

Measured here: 3.3GB requested for ~900MB of actual usage. The node refused to
schedule Argo CD while sitting at 22% memory, and the API server was starved
during bursts. `kubectl top` showed nothing wrong, because it reports usage.

```bash
kubectl describe node | grep -A6 "Allocated resources"   # requests — what matters
kubectl top pods -n rootsmarket --sort-by=memory         # usage — what you feel
```

Right-size from the second, then check the first.

## Secrets

Argo CD syncs from git, and a Kubernetes Secret is base64, not encryption.
Sealed Secrets closes that: `kubeseal` encrypts with the controller's public
key, and only the private key — which never leaves the cluster — can decrypt.

| File | Contents | In git |
|---|---|---|
| `base/config/secret.yaml` | plaintext | **never** — gitignored |
| `base/config/sealed-secret.yaml` | ciphertext | yes |
| the controller's private key | the key | **never** — password manager |

Two properties worth knowing: a SealedSecret is bound to its exact **name and
namespace**, so copying it elsewhere yields nothing; and the ciphertext differs
every time you seal, so re-running `seal` produces a changed file with no
actual change.

**Back up the private key.** It is generated in-cluster and is not in git. Lose
the cluster without it and every SealedSecret in this repo is permanently
undecryptable.

```bash
kubectl -n kube-system get secret \
  -l sealedsecrets.bitnami.com/sealed-secrets-key -o yaml > ~/sealed-secrets-key.yaml
```

A new cluster generates a new key, so moving to another cluster means
re-sealing from the plaintext — which is why the plaintext is kept locally.

## Why k3d, not kind

kind runs a full kubeadm control plane: etcd, kube-apiserver,
kube-controller-manager and kube-scheduler as separate static pods. On an 8GB
machine with ~4GB given to Docker, that control plane was starved repeatedly —
`etcdserver: request timed out` on apply, then `TLS handshake timeout` from
every kubectl call. Not one of those failures was a manifest problem.

k3s runs the control plane as a single binary and uses SQLite instead of etcd:
roughly half the idle footprint, and etcd was the component timing out. The
cluster config disables Traefik and ServiceLB (unused here) and the k3d load
balancer (it balances one server), and keeps metrics-server — which is what
makes `kubectl top` work, and it was unavailable on kind exactly when it would
have diagnosed the starvation.

The honest trade: k3s is not upstream Kubernetes. It bundles components,
swaps the datastore, and omits some alpha features. None of that matters for
probes, Services, Kustomize, sync waves or Argo CD.

`cluster/kind-cluster.yaml` is kept because the reasoning is worth having in
the repo, and because a machine with more memory should prefer it.

## Troubleshooting

Real failures from building this, with the line that identified each.

| Symptom | Cause |
|---|---|
| `ComparisonError ... helm pull ... 404` | wrong chart repo URL — the org is `bitnami-labs`, the Pages site is `bitnami.github.io` |
| `name resolver error: produced zero addresses` | no ready pod behind a Service — read it literally: zero addresses means no endpoints |
| RabbitMQ CrashLoop, sixty lines of Erlang | `Cookie file .erlang.cookie must be accessible by owner only` — `fsGroup` chown made it group-readable; fixed with `fsGroupChangePolicy: OnRootMismatch` |
| `relation "users" does not exist`, health checks all green | init SQL was a `SELECT 1;` placeholder. It ran successfully. `pg_isready` and the services' own `SELECT 1` both pass on an empty database |
| ConfigMap "configured" but unchanged in the cluster | a generated ConfigMap has no namespace of its own and landed in `default`; `apply` was succeeding against the wrong object |
| Pod killed, exit code **0**, `Completed` | a liveness probe killed it and the app shut down gracefully. Exit-code alerting sees nothing wrong |
| `Insufficient memory` while `kubectl top` shows the node half empty | requests, not usage |
| Argo CD Application stuck `Unknown` | it could not fetch or render the source — always a repo or chart problem, never cluster state |

Two habits that shortened most of these: read the **innermost** frame of a
wrapped error, and read the **live object**, not the manifest you think you
applied.