# # 1. push the new ConfigMap to the cluster, and confirm it has BOTH keys live
# kubectl apply -k infra/k8s/base/db
# kubectl -n rootsmarket get cm postgres-init -o jsonpath='{.data}' \
#   | python3 -c 'import sys,json;print(list(json.load(sys.stdin)))'
# #    want: ['01-schema.sql', '02-seed.sql']

# # 2. wipe — StatefulSet first, then its PVC
# kubectl -n rootsmarket delete statefulset postgres
# kubectl -n rootsmarket delete pvc data-postgres-0
# kubectl -n rootsmarket get pvc          

# # 3. recreate and wait
# kubectl apply -k infra/k8s/base/db
# kubectl -n rootsmarket rollout status statefulset/postgres --timeout=180s

# # 4. confirm init actually ran the real files
# kubectl -n rootsmarket logs postgres-0 | grep -E "running /docker-entrypoint|CREATE TABLE|INSERT|ERROR"
# kubectl -n rootsmarket exec postgres-0 -- psql -U rootsmarket -d rootsmarket -c '\dt'

kubectl -n rootsmarket delete cm postgres-init
kubectl apply -k infra/k8s/base/db
kubectl -n rootsmarket get cm postgres-init -o jsonpath='{.data}' \
  | python3 -c 'import sys,json;d=json.load(sys.stdin);print(list(d));print(d["01-schema.sql"][:120])'