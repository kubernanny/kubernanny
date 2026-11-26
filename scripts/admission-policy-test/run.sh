#!/usr/bin/env bash
# Runs the chart's ValidatingAdmissionPolicies in a real kube-apiserver (envtest: kube-apiserver and etcd,
# no kubelet, no controllers) with the real CRDs of the components the actions touch, then sends allowed
# and forbidden requests as the agent's ServiceAccount (requests.sh). Needs Go, Helm, kubectl, network.
#   scripts/admission-policy-test/run.sh
set -euo pipefail
cd "$(dirname "$0")"
ROOT=$(cd ../.. && pwd)
WORK=$(mktemp -d)
SERVER=
trap 'kill $SERVER 2>/dev/null || true; chmod -R u+w "$WORK"; rm -rf "$WORK"' EXIT
GOBIN="$WORK" go install sigs.k8s.io/controller-runtime/tools/setup-envtest@release-0.21
ASSETS=$("$WORK/setup-envtest" use 1.33.x --bin-dir "$WORK/bin" -p path)
go build -o "$WORK/apiserver" .
"$WORK/apiserver" "$ASSETS" "$WORK/kubeconfig" >"$WORK/apiserver.log" 2>&1 &
SERVER=$!
until grep -q READY "$WORK/apiserver.log" 2>/dev/null; do sleep 1; done
export KUBECONFIG="$WORK/kubeconfig"
mkdir -p "$WORK/crds" && cd "$WORK/crds"
for u in \
  https://github.com/cert-manager/cert-manager/releases/download/v1.18.2/cert-manager.crds.yaml \
  https://raw.githubusercontent.com/vmware-tanzu/velero/v1.16.2/config/crd/v1/bases/velero.io_backups.yaml \
  https://raw.githubusercontent.com/argoproj/argo-cd/v3.1.2/manifests/crds/application-crd.yaml \
  https://github.com/fluxcd/kustomize-controller/releases/download/v1.6.1/kustomize-controller.crds.yaml \
  https://raw.githubusercontent.com/external-secrets/external-secrets/v0.19.2/config/crds/bases/external-secrets.io_externalsecrets.yaml \
  https://raw.githubusercontent.com/Infisical/kubernetes-operator/main/config/crd/bases/secrets.infisical.com_infisicalstaticsecrets.yaml \
  https://raw.githubusercontent.com/cloudnative-pg/cloudnative-pg/v1.26.1/config/crd/bases/postgresql.cnpg.io_backups.yaml; do
  curl -sSLf -O "$u"
done
curl -sSLf -o "$WORK/longhorn.yaml" https://raw.githubusercontent.com/longhorn/longhorn/v1.9.0/deploy/longhorn.yaml
cd - >/dev/null
node longhorn-crds.mjs "$WORK/longhorn.yaml" "$WORK/crds/longhorn-crds.yaml" >/dev/null
kubectl apply --server-side -f "$WORK/crds" >/dev/null
kubectl create namespace kubernanny >/dev/null
# Every action on, the opt-in ones included.
helm template kubernanny "$ROOT/deploy/helm/kubernanny" -n kubernanny --api-versions admissionregistration.k8s.io/v1/ValidatingAdmissionPolicy \
  --set 'actions.enabled={job-rerun,force-delete-terminating,argocd-terminate-op,pvc-expand,argocd-rollback,config-change-hint,argocd-sync-prune,argocd-sync-replace}' | kubectl apply -f - >/dev/null
sleep 2
KUBECONFIG="$WORK/kubeconfig" ./requests.sh | tee "$WORK/out.txt"
# Again with the other opt-ins only: the sync may not prune or replace (the other sections run once more, unchanged).
helm template kubernanny "$ROOT/deploy/helm/kubernanny" -n kubernanny --api-versions admissionregistration.k8s.io/v1/ValidatingAdmissionPolicy \
  --set 'actions.enabled={job-rerun,force-delete-terminating,argocd-terminate-op,pvc-expand,argocd-rollback,config-change-hint}' | kubectl apply -f - >/dev/null
sleep 2
KUBECONFIG="$WORK/kubeconfig" R=$(($(date +%s) + 7)) SYNC_OPTIONS_LOCKED=1 ./requests.sh | tee -a "$WORK/out.txt"
! grep -q '^FAIL' "$WORK/out.txt"

