#!/usr/bin/env bash
# Allowed and forbidden requests as the agent's ServiceAccount against the policies (run.sh sets it all up).
export KUBECONFIG=${KUBECONFIG:-$(dirname "$0")/kubeconfig}
AS="--as=system:serviceaccount:kubernanny:kubernanny"
PASS=0; FAILN=0
R=${R:-$(date +%s)}
export SH=shop-$R AR=argocd-$R VE=velero-$R LH=longhorn-$R
expect() { # allow|deny description command...
  local want=$1 desc=$2; shift 2
  local out; out=$("$@" 2>&1); local rc=$?
  local got=allow; [ $rc -ne 0 ] && got=deny
  if [ "$got" = "$want" ]; then PASS=$((PASS+1)); echo "ok    $want  $desc$([ "$want" = deny ] && echo " :: $(echo "$out" | tail -1 | sed 's/.*denied request: //' | cut -c1-110)")"; else FAILN=$((FAILN+1)); echo "FAIL  want $want got $got: $desc :: $(echo "$out" | tail -1)"; fi
}
k() { kubectl "$@"; }
ka() { kubectl $AS "$@"; }
k create ns $SH >/dev/null 2>&1
# ---- nodes
k apply -f - >/dev/null <<Y
apiVersion: v1
kind: Node
metadata: { name: n4-$R }
spec: { unschedulable: true }
---
apiVersion: v1
kind: Node
metadata: { name: n5-$R }
Y
expect allow "uncordon a cordoned node" ka patch node n4-$R --type=merge -p '{"spec":{"unschedulable":false}}'
expect deny  "cordon a node" ka patch node n5-$R --type=merge -p '{"spec":{"unschedulable":true}}'
k patch node n4-$R --type=merge -p '{"spec":{"unschedulable":true}}' >/dev/null
expect deny  "uncordon and label at once" ka patch node n4-$R --type=merge -p '{"spec":{"unschedulable":false},"metadata":{"labels":{"x":"y"}}}'
expect deny  "delete a node" ka delete node n5-$R --wait=false
# ---- pods
for p in failed running stuck; do k -n $SH run $p --image=busybox --restart=Never ${p/stuck/--overrides={\"metadata\":{\"finalizers\":[\"example.com/hold\"]\}\}} >/dev/null 2>&1; done
k -n $SH patch pod failed --subresource=status --type=merge -p '{"status":{"phase":"Failed","reason":"Evicted"}}' >/dev/null
k -n $SH delete pod stuck --wait=false >/dev/null
expect allow "delete a failed pod" ka -n $SH delete pod failed --wait=false
expect deny  "delete a pending (running) pod" ka -n $SH delete pod running --wait=false
expect allow "force-delete a pod already terminating" ka -n $SH delete pod stuck --grace-period=0 --force --wait=false
expect deny  "create a pod" ka -n $SH run evil --image=busybox --restart=Never
# ---- jobs
job() { # name container-extra label-extra ownerReferences pod-extra [template-annotations]
  cat <<J
{"apiVersion":"batch/v1","kind":"Job","metadata":{"name":"$1","namespace":"$SH","labels":{"app.kubernetes.io/created-by":"kubernanny"$3},"ownerReferences":$4},"spec":{"template":{"metadata":{"annotations":{${6:-}}},"spec":{"restartPolicy":"Never","containers":[{"name":"c","image":"busybox"$2}]$5}}}}
J
}
# A run of the CronJob with one change to the container ($2), the pod ($3) or the template's annotations ($4).
cron() { sh -c "$(declare -f job); job $1 '$2' '' '$CRON' '$3' '$4' | kubectl $AS create -f -"; }
CRON='[{"apiVersion":"batch/v1","kind":"CronJob","name":"nightly","uid":"6f0d7c6e-0000-4000-8000-000000000001","controller":true}]'
expect allow "a run of a CronJob" sh -c "$(declare -f job); job run1 '' '' '$CRON' '' | kubectl $AS create -f -"
expect allow "a rerun of a Job without owner" sh -c "$(declare -f job); job run2 '' ',\"kubernanny.io/rerun-of\":\"migrate\"' '[]' '' | kubectl $AS create -f -"
expect deny  "a rerun that also has an owner" sh -c "$(declare -f job); job run3 '' ',\"kubernanny.io/rerun-of\":\"migrate\"' '[{\"apiVersion\":\"apps/v1\",\"kind\":\"Deployment\",\"name\":\"x\",\"uid\":\"6f0d7c6e-0000-4000-8000-000000000002\"}]' '' | kubectl $AS create -f -"
expect deny  "a Job neither from a CronJob nor a rerun" sh -c "$(declare -f job); job run4 '' '' '[]' '' | kubectl $AS create -f -"
expect deny  "a privileged container" sh -c "$(declare -f job); job run5 ',\"securityContext\":{\"privileged\":true}' '' '$CRON' '' | kubectl $AS create -f -"
expect deny  "allowPrivilegeEscalation true" sh -c "$(declare -f job); job run6 ',\"securityContext\":{\"allowPrivilegeEscalation\":true}' '' '$CRON' '' | kubectl $AS create -f -"
expect deny  "an added capability" sh -c "$(declare -f job); job run7 ',\"securityContext\":{\"capabilities\":{\"add\":[\"NET_ADMIN\"]}}' '' '$CRON' '' | kubectl $AS create -f -"
expect deny  "hostNetwork" sh -c "$(declare -f job); job run8 '' '' '$CRON' ',\"hostNetwork\":true' | kubectl $AS create -f -"
expect deny  "a hostPath volume" sh -c "$(declare -f job); job run9 '' '' '$CRON' ',\"volumes\":[{\"name\":\"h\",\"hostPath\":{\"path\":\"/\"}}]' | kubectl $AS create -f -"
# Pod Security Standards baseline, pod and container level (pod-security.ts holds the same list).
expect allow "baseline: capabilities from the allowlist, drop ALL" cron b1 ',"securityContext":{"capabilities":{"add":["NET_BIND_SERVICE","CHOWN"],"drop":["ALL"]}}' ''
expect allow "baseline: SELinux container_t, seccomp RuntimeDefault, AppArmor Localhost" cron b2 ',"securityContext":{"seLinuxOptions":{"type":"container_t"},"seccompProfile":{"type":"RuntimeDefault"},"appArmorProfile":{"type":"Localhost","localhostProfile":"p"}}' ''
expect allow "baseline: safe sysctls, hostPort 0, AppArmor annotation runtime/default" cron b3 ',"ports":[{"containerPort":80,"hostPort":0}]' ',"securityContext":{"sysctls":[{"name":"net.ipv4.ip_local_port_range","value":"1024 65535"}]}' '"container.apparmor.security.beta.kubernetes.io/c":"runtime/default"'
expect deny  "baseline: SYS_ADMIN" cron d1 ',"securityContext":{"capabilities":{"add":["SYS_ADMIN"]}}' ''
expect deny  "baseline: a hostPort" cron d2 ',"ports":[{"containerPort":80,"hostPort":8080}]' ''
expect deny  "baseline: SELinux spc_t on the pod" cron d3 '' ',"securityContext":{"seLinuxOptions":{"type":"spc_t"}}'
expect deny  "baseline: SELinux user on a container" cron d4 ',"securityContext":{"seLinuxOptions":{"user":"system_u"}}' ''
expect deny  "baseline: SELinux role on the pod" cron d5 '' ',"securityContext":{"seLinuxOptions":{"role":"sysadm_r"}}'
expect deny  "baseline: procMount Unmasked" cron d6 ',"securityContext":{"procMount":"Unmasked"}' ',"hostUsers":false'
expect deny  "baseline: seccomp Unconfined on the pod" cron d7 '' ',"securityContext":{"seccompProfile":{"type":"Unconfined"}}'
expect deny  "baseline: seccomp Unconfined on a container" cron d8 ',"securityContext":{"seccompProfile":{"type":"Unconfined"}}' ''
expect deny  "baseline: AppArmor Unconfined field on a container" cron d9 ',"securityContext":{"appArmorProfile":{"type":"Unconfined"}}' ''
expect deny  "baseline: AppArmor Unconfined field on the pod" cron d10 '' ',"securityContext":{"appArmorProfile":{"type":"Unconfined"}}'
expect deny  "baseline: AppArmor unconfined annotation" cron d11 '' '' '"container.apparmor.security.beta.kubernetes.io/c":"unconfined"'
expect deny  "baseline: an unsafe sysctl" cron d12 '' ',"securityContext":{"sysctls":[{"name":"kernel.msgmax","value":"65536"}]}'
expect deny  "baseline: a privileged init container" cron d13 '' ',"initContainers":[{"name":"i","image":"busybox","securityContext":{"privileged":true}}]'
expect deny  "baseline: NET_ADMIN on an init container" cron d14 '' ',"initContainers":[{"name":"i","image":"busybox","securityContext":{"capabilities":{"add":["NET_ADMIN"]}}}]'
expect deny  "baseline: a probe to another host" cron d15 ',"readinessProbe":{"httpGet":{"host":"10.0.0.1","port":80}}' ''
expect deny  "baseline: a lifecycle hook to another host" cron d16 ',"lifecycle":{"postStart":{"tcpSocket":{"host":"db","port":5432}}}' ''
expect deny  "baseline: hostPID" cron d17 '' ',"hostPID":true'
# ---- pvcs
k apply -f - >/dev/null <<Y
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata: { name: grow }
provisioner: example.com/x
allowVolumeExpansion: true
---
apiVersion: v1
kind: PersistentVolume
metadata: { name: pv-data-$R }
spec: { capacity: { storage: 8Gi }, accessModes: [ReadWriteOnce], storageClassName: grow, hostPath: { path: /tmp/x }, claimRef: { namespace: $SH, name: data } }
---
apiVersion: v1
kind: PersistentVolumeClaim
metadata: { name: data, namespace: $SH }
spec: { storageClassName: grow, accessModes: [ReadWriteOnce], volumeName: pv-data-$R, resources: { requests: { storage: 8Gi } } }
Y
k -n $SH patch pvc data --subresource=status --type=merge -p '{"status":{"phase":"Bound","capacity":{"storage":"8Gi"}}}' >/dev/null
expect deny  "grow a claim by more than half" ka -n $SH patch pvc data --type=merge -p '{"spec":{"resources":{"requests":{"storage":"20Gi"}}}}'
expect allow "grow a claim by a quarter" ka -n $SH patch pvc data --type=merge -p '{"spec":{"resources":{"requests":{"storage":"10Gi"}}}}'
expect deny  "grow and label at once" ka -n $SH patch pvc data --type=merge -p '{"spec":{"resources":{"requests":{"storage":"11Gi"}}},"metadata":{"labels":{"x":"y"}}}'
expect deny  "delete a claim" ka -n $SH delete pvc data --wait=false
# ---- certificates
k apply -f - >/dev/null <<Y
apiVersion: cert-manager.io/v1
kind: Certificate
metadata: { name: tls, namespace: $SH }
spec: { secretName: tls, dnsNames: [shop.example], issuerRef: { name: le, kind: ClusterIssuer } }
Y
k -n $SH patch certificate tls --subresource=status --type=merge -p '{"status":{"notAfter":"2026-12-01T00:00:00Z","conditions":[{"type":"Ready","status":"True","reason":"Ready","message":"ok","lastTransitionTime":"2026-11-01T00:00:00Z"}]}}' >/dev/null
# kubectl patch --subresource reads the object first (get certificates/status, which the agent does not hold);
# the agent sends the PATCH alone, so this goes through a proxy that impersonates it.
kubectl $AS proxy --port=$((18000 + R % 900)) >/dev/null 2>&1 &
PROXY=$!; sleep 2
cpatch() { curl -sf -o /dev/null -X PATCH -H 'Content-Type: application/merge-patch+json' --data "$1" http://127.0.0.1:$((18000 + R % 900))/apis/cert-manager.io/v1/namespaces/$SH/certificates/tls/status; }
READY='{"type":"Ready","status":"True","reason":"Ready","message":"ok","lastTransitionTime":"2026-11-01T00:00:00Z"}'
ISSUING='{"type":"Issuing","status":"True","reason":"ManuallyTriggered","message":"m","lastTransitionTime":"2026-11-26T00:00:00Z"}'
expect deny  "change notAfter" cpatch '{"status":{"notAfter":"2030-01-01T00:00:00Z"}}'
expect deny  "drop the Ready condition" cpatch "{\"status\":{\"conditions\":[$ISSUING]}}"
expect deny  "Issuing with another reason" cpatch "{\"status\":{\"conditions\":[$READY,{\"type\":\"Issuing\",\"status\":\"True\",\"reason\":\"Other\",\"message\":\"m\",\"lastTransitionTime\":\"2026-11-26T00:00:00Z\"}]}}"
expect allow "renew: Issuing=True ManuallyTriggered" cpatch "{\"status\":{\"conditions\":[$READY,$ISSUING]}}"
kill $PROXY
expect deny  "patch the Certificate itself" ka -n $SH patch certificate tls --type=merge -p '{"spec":{"dnsNames":["evil.example"]}}'
# ---- reconcile annotations
k apply -f - >/dev/null <<Y
apiVersion: kustomize.toolkit.fluxcd.io/v1
kind: Kustomization
metadata: { name: apps, namespace: $SH }
spec: { interval: 10m, path: ./apps, prune: true, sourceRef: { kind: GitRepository, name: repo } }
---
apiVersion: external-secrets.io/v1
kind: ExternalSecret
metadata: { name: db, namespace: $SH }
spec: { secretStoreRef: { name: store, kind: ClusterSecretStore }, target: { name: db } }
---
apiVersion: secrets.infisical.com/v1beta1
kind: InfisicalStaticSecret
metadata: { name: token, namespace: $SH }
spec: { sources: [], targets: [], syncOptions: { refreshInterval: 1m } }
Y
expect allow "flux requestedAt" ka -n $SH annotate kustomization apps reconcile.fluxcd.io/requestedAt=now --overwrite
expect deny  "another annotation" ka -n $SH annotate kustomization apps evil=1
expect deny  "the spec" ka -n $SH patch kustomization apps --type=merge -p '{"spec":{"path":"./evil"}}'
expect allow "ESO force-sync" ka -n $SH annotate externalsecret db force-sync=1795600000 --overwrite
expect allow "Infisical requested-at" ka -n $SH annotate infisicalstaticsecret token kubernanny.io/requested-at=now --overwrite
# ---- longhorn
k create ns $LH >/dev/null 2>&1
lh() { printf '{"apiVersion":"longhorn.io/v1beta2","kind":"%s","metadata":{"name":"%s","namespace":"'"$LH"'","labels":%s},"spec":%s}' "$@"; }
expect allow "a snapshot" sh -c "$(declare -f lh); lh Snapshot s1 '{\"app.kubernetes.io/created-by\":\"kubernanny\"}' '{\"volume\":\"pvc-1\",\"createSnapshot\":true}' | kubectl $AS create -f -"
expect allow "a backup of it" sh -c "$(declare -f lh); lh Backup b1 '{\"app.kubernetes.io/created-by\":\"kubernanny\",\"backup-volume\":\"pvc-1\"}' '{\"snapshotName\":\"s1\"}' | kubectl $AS create -f -"
expect deny  "a full backup" sh -c "$(declare -f lh); lh Backup b2 '{\"app.kubernetes.io/created-by\":\"kubernanny\",\"backup-volume\":\"pvc-1\"}' '{\"snapshotName\":\"s1\",\"backupMode\":\"full\"}' | kubectl $AS create -f -"
expect deny  "a snapshot without the label" sh -c "$(declare -f lh); lh Snapshot s2 '{}' '{\"volume\":\"pvc-1\",\"createSnapshot\":true}' | kubectl $AS create -f -"
# ---- velero
k create ns $VE >/dev/null 2>&1
vb() { printf '{"apiVersion":"velero.io/v1","kind":"Backup","metadata":{"name":"%s","namespace":"'"$VE"'","labels":{"app.kubernetes.io/created-by":"kubernanny","velero.io/schedule-name":"daily"}},"spec":%s}' "$@"; }
expect allow "a backup from a schedule" sh -c "$(declare -f vb); vb daily-1 '{\"includedNamespaces\":[\"shop\"],\"ttl\":\"720h0m0s\"}' | kubectl $AS create -f -"
expect deny  "a backup with hooks" sh -c "$(declare -f vb); vb daily-2 '{\"hooks\":{\"resources\":[{\"name\":\"x\",\"pre\":[{\"exec\":{\"command\":[\"sh\",\"-c\",\"id\"]}}]}]}}' | kubectl $AS create -f -"
expect deny  "a backup with a resource policy" sh -c "$(declare -f vb); vb daily-3 '{\"resourcePolicy\":{\"kind\":\"configmap\",\"name\":\"p\"}}' | kubectl $AS create -f -"
expect deny  "a backup with an order" sh -c "$(declare -f vb); vb daily-4 '{\"orderedResources\":{\"pods\":\"shop/a\"}}' | kubectl $AS create -f -"
# ---- argo cd
k create ns $AR >/dev/null 2>&1
k apply -f - >/dev/null <<Y
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata: { name: shop, namespace: $AR }
spec: { project: default, destination: { namespace: $SH, server: https://kubernetes.default.svc }, source: { repoURL: https://git.example/x.git, path: apps, targetRevision: main } }
status: { sync: { status: OutOfSync }, operationState: { phase: Running, startedAt: "2026-11-26T05:00:00Z", operation: { sync: {} } } }
Y
expect allow "end a running operation" ka -n $AR patch application shop --type=merge -p '{"status":{"operationState":{"phase":"Terminating"}}}'
k -n $AR patch application shop --type=merge -p '{"status":{"operationState":{"phase":"Running"}}}' >/dev/null
expect deny  "end it and change the sync status" ka -n $AR patch application shop --type=merge -p '{"status":{"operationState":{"phase":"Terminating"},"sync":{"status":"Synced"}}}'
expect allow "a plain sync" ka -n $AR patch application shop --type=merge -p '{"operation":{"initiatedBy":{"username":"kubernanny"},"sync":{"syncStrategy":{"hook":{}}}}}'
expect deny  "a sync with another source" ka -n $AR patch application shop --type=merge -p '{"operation":{"initiatedBy":{"username":"kubernanny"},"sync":{"syncStrategy":{"hook":{}},"source":{"repoURL":"https://evil.example/x.git"}}}}'
# Sync options: the app's own, ServerSideApply=true, and (opt-in) Replace=true and prune while the app lists a resource to prune.
k apply -f - >/dev/null <<Y
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata: { name: web, namespace: $AR }
spec: { project: default, destination: { namespace: $SH, server: https://kubernetes.default.svc }, source: { repoURL: https://git.example/x.git, path: web, targetRevision: main }, syncPolicy: { syncOptions: [CreateNamespace=true, ServerSideApply=true] } }
status: { sync: { status: OutOfSync }, resources: [ { kind: CronJob, group: batch, version: v1, name: cleanup, namespace: $SH, status: OutOfSync, requiresPruning: true } ] }
Y
reset() { k -n $AR patch application "$1" --type=json -p '[{"op":"remove","path":"/operation"}]' >/dev/null 2>&1 || true; }
sync() { # app sync-json-fields
  ka -n $AR patch application "$1" --type=merge -p "{\"operation\":{\"initiatedBy\":{\"username\":\"kubernanny\"},\"info\":[{\"name\":\"Reason\",\"value\":\"Sync from the Kubernanny app\"}],\"sync\":{\"syncStrategy\":{\"hook\":{}}$2}}}"
}
syncs() { # allow|deny description app sync-json-fields: one request on a fresh operation
  reset "$3"; expect "$1" "$2" sync "$3" "$4"
}
syncs allow "a sync with the app's own options" web ',"syncOptions":["CreateNamespace=true","ServerSideApply=true"]'
syncs allow "a sync with ServerSideApply=true on an app without options" shop ',"syncOptions":["ServerSideApply=true"]'
syncs deny  "a sync with an option the app does not name (PruneLast)" shop ',"syncOptions":["PruneLast=true"]'
syncs deny  "a sync with Force=true" web ',"syncOptions":["CreateNamespace=true","Force=true"]'
syncs deny  "a sync with Validate=false" web ',"syncOptions":["Validate=false"]'
syncs deny  "ServerSideApply=false smuggled as another value" shop ',"syncOptions":["ServerSideApply=false"]'
if [ "${SYNC_OPTIONS_LOCKED:-0}" = 1 ]; then
  # Rendered without actions.enabled: [argocd-sync-prune, argocd-sync-replace].
  syncs deny  "prune while argocd-sync-prune is not enabled" web ',"prune":true'
  syncs deny  "Replace=true while argocd-sync-replace is not enabled" shop ',"syncOptions":["Replace=true"]'
else
  syncs allow "prune on an app that lists a resource to prune" web ',"prune":true'
  syncs allow "prune with the app's options and Replace=true" web ',"prune":true,"syncOptions":["CreateNamespace=true","ServerSideApply=true","Replace=true"]'
  syncs deny  "prune on an app with nothing to prune" shop ',"prune":true'
  syncs allow "Replace=true" shop ',"syncOptions":["Replace=true"]'
  syncs deny  "Replace=true with Force=true" shop ',"syncOptions":["Replace=true","Force=true"]'
  syncs deny  "prune as a dry run" web ',"prune":true,"dryRun":true'
fi
reset web; reset shop
# ---- restart
k -n $SH create deployment web --image=busybox >/dev/null 2>&1
expect allow "restart a Deployment" ka -n $SH patch deployment web --type=merge -p '{"spec":{"template":{"metadata":{"annotations":{"kubectl.kubernetes.io/restartedAt":"2026-11-26T06:00:00Z"}}}}}'
expect deny  "change its image" ka -n $SH set image deployment/web busybox=evil
# ---- cnpg
expect allow "a CNPG backup" sh -c "printf '{\"apiVersion\":\"postgresql.cnpg.io/v1\",\"kind\":\"Backup\",\"metadata\":{\"generateName\":\"pg-kubernanny-\",\"namespace\":\"$SH\"},\"spec\":{\"cluster\":{\"name\":\"pg\"}}}' | kubectl $AS create -f -"
# ---- configmaps: only with the opt-in config-change-hint (this cluster has it on)
k -n $SH create configmap app-config --from-literal=a=b >/dev/null 2>&1
expect allow "get a ConfigMap (opt-in hint on)" ka -n $SH get configmap app-config
expect deny  "list ConfigMaps" ka -n $SH get configmaps
echo "passed $PASS, failed $FAILN"
