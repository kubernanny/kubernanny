import { ActionType } from '../checks/types';
import { Rule } from './rules';

/**
 * The facts behind docs/PERMISSIONS.md that are not module declarations.
 * Each list is checked against the chart, install.yaml or the agent's code
 * by `permissions-doc.spec.ts`, so the page cannot describe something the
 * deployment does not do.
 */

export interface ExplainedRule extends Rule {
  why: string;
}

/**
 * The static ClusterRole lines of `templates/rbac.yaml`: what every run reads, whatever is switched off.
 * `watch` on the kinds the agent keeps current with watches (`inventory/cluster-cache.ts`); without it
 * the agent falls back to listing them every run.
 */
export const INVENTORY_READS: readonly ExplainedRule[] = [
  {
    group: '',
    resources: ['nodes', 'pods', 'services', 'namespaces', 'events', 'persistentvolumeclaims'],
    verbs: ['get', 'list', 'watch'],
    why: 'nodes, pod health, which service belongs to a component, warning events, volumes',
  },
  {
    group: 'apps',
    resources: ['deployments', 'statefulsets', 'daemonsets'],
    verbs: ['get', 'list', 'watch'],
    why: 'workload readiness, the owner of a crashing pod, component recognition by image',
  },
  {
    group: 'batch',
    resources: ['jobs', 'cronjobs'],
    verbs: ['get', 'list', 'watch'],
    why: 'failed jobs and missed schedules',
  },
  {
    group: 'networking.k8s.io',
    resources: ['ingresses'],
    verbs: ['get', 'list', 'watch'],
    why: 'which component is reachable under which address',
  },
  { group: 'storage.k8s.io', resources: ['storageclasses'], verbs: ['get', 'list', 'watch'], why: 'the Storage tab' },
  {
    group: 'metrics.k8s.io',
    resources: ['nodes', 'pods'],
    verbs: ['get', 'list'],
    why: 'CPU and memory, when metrics-server runs',
  },
  {
    group: 'gateway.networking.k8s.io',
    resources: ['httproutes'],
    verbs: ['get', 'list'],
    why: 'addresses published through the Gateway API',
  },
  {
    group: 'traefik.io',
    resources: ['ingressroutes'],
    verbs: ['get', 'list'],
    why: 'addresses published as Traefik IngressRoutes',
  },
  {
    group: 'traefik.containo.us',
    resources: ['ingressroutes'],
    verbs: ['get', 'list'],
    why: 'the same, older Traefik API group',
  },
];

export type WriteActionType = Exclude<ActionType, 'logs' | 'config-change-hint'>;

/** What each write action changes, exactly as `actions/actions.service.ts` (`actions/rollback.service.ts`) sends it (the spec checks the strings are there). */
/**
 * `admission`: what the chart's ValidatingAdmissionPolicy
 * (`templates/admission-policy.yaml`, `rbac.admissionPolicy.enabled`) still
 * lets the agent's ServiceAccount do with that permission, so a compromised
 * pod cannot use it for more than the action.
 */
export const WRITE_EFFECTS: Record<WriteActionType, { changes: string; marker: string; admission: string }> = {
  restart: {
    changes:
      'merge patch of `spec.template.metadata.annotations["kubectl.kubernetes.io/restartedAt"]` on the Deployment, StatefulSet or DaemonSet the issue names: the same as `kubectl rollout restart`. With the opt-in `config-change-hint` the restart of a crash loop whose env ConfigMap changed after the last start is offered first, as the fix',
    marker: 'kubectl.kubernetes.io/restartedAt',
    admission:
      'only an UPDATE that changes nothing but that annotation (spec, template spec and labels, the other annotations, metadata compared); no create, no delete',
  },
  'argocd-sync': {
    changes:
      'merge patch of `operation` (a sync with `initiatedBy.username: kubernanny`) on the Application the issue names: the same as pressing Sync in Argo CD',
    marker: "initiatedBy: { username: 'kubernanny' }",
    admission:
      'only `operation` (a sync initiated by `kubernanny`, without `revision(s)`, `source(s)`, `manifests` or `resources`) and the refresh annotation; spec, status, labels, other annotations unchanged; no create, no delete',
  },
  'argocd-rollback': {
    changes:
      "off unless named in `actions.enabled`. Merge patch of `operation` (a sync with `initiatedBy.username: kubernanny` and `sync.revision` set to an earlier entry of the app's own `status.history`, no source, no prune, no options) on a manual-sync, single-source Application the request names: like `argocd app sync --revision`, the app's `spec.source` at that revision. Adds no RBAC verb (the same `patch` as `argocd-sync`), only a branch of the admission policy",
    marker: 'sync: { revision: decided.revision, syncStrategy: { hook: {} } }',
    admission:
      'rendered only with `actions.enabled: [argocd-rollback]`: additionally a sync initiated by `kubernanny` whose `revision` is the revision of an entry in the stored `status.history` with the same repository as `spec.source`, on an app without automated sync and with a single `spec.source`; no `revisions`, `source(s)`, `manifests`, `resources`, `prune`, `dryRun`, `syncOptions`, `retry`, `apply` or `force`, `info` only `Reason`',
  },
  'argocd-refresh': {
    changes:
      'merge patch of the annotation `argocd.argoproj.io/refresh: hard` on the Application the issue names: the same as a hard refresh in Argo CD',
    marker: "'argocd.argoproj.io/refresh': 'hard'",
    admission: 'the same policy as `argocd-sync`: the refresh annotation set to `hard` or `normal`, nothing else',
  },
  'cnpg-backup': {
    changes:
      'creates one `Backup` object (`generateName: <cluster>-kubernanny-`, label `app.kubernetes.io/created-by: kubernanny`) for the database cluster the issue names: the same as `kubectl cnpg backup`',
    marker: "kind: 'Backup'",
    admission:
      'only CREATE of a Backup naming a cluster, without `target`, `online`, `onlineConfiguration` or `pluginConfiguration`, and with `method` at most the default the CRD fills in (`barmanObjectStore`); whether the cluster exists is not checked (CNPG fails such a Backup)',
  },
  uncordon: {
    changes:
      'merge patch of `spec.unschedulable: false` on the node the issue names (Ready, cordoned for 30 minutes, no kured lock, no drain under way): the same as `kubectl uncordon`',
    marker: '{ spec: { unschedulable: false } }',
    admission:
      'only an UPDATE that turns `spec.unschedulable` from true to false; labels, annotations, taints and the rest of the spec unchanged; no create, no delete',
  },
  'job-rerun': {
    changes:
      'off unless named in `actions.enabled`. Creates one Job: from the jobTemplate of the CronJob the issue names, owned by it and annotated `cronjob.kubernetes.io/instantiate: manual` (like `kubectl create job --from=cronjob/…`), or a copy of a failed Job without owner, without its controller-uid labels and selector, labelled `kubernanny.io/rerun-of`',
    marker: "'cronjob.kubernetes.io/instantiate': 'manual'",
    admission:
      'only CREATE of a Job labelled `app.kubernetes.io/created-by: kubernanny` that is either owned by exactly one CronJob (`controller: true`) or carries `kubernanny.io/rerun-of` and no owner, without `manualSelector`, and whose pod template stays within the Pod Security Standards baseline profile at pod and container level, init containers included (no host namespaces, hostPath, hostPort, hostProcess or privileged container; capabilities only from the baseline allowlist; SELinux type only `container_t`, `container_init_t`, `container_kvm_t` or `container_engine_t` and no user or role; `procMount` only `Default`; no `Unconfined` seccomp or AppArmor, by field or annotation; only the baseline safe sysctls; probes and lifecycle hooks only to the pod itself), plus no `allowPrivilegeEscalation: true` and no ephemeral containers (the agent refuses to rerun such a Job itself, `actions/pod-security.ts`). The policy cannot compare the rest of the template, image and ServiceAccount included, with the CronJob (it sees only the request): a compromised pod could still run any image as any ServiceAccount of any namespace within the baseline profile, which is why the action is opt-in',
  },
  'reconcile-now': {
    changes:
      'merge patch of one annotation on the object the issue names: `reconcile.fluxcd.io/requestedAt` on a Flux Kustomization or HelmRelease (`flux reconcile`), `force-sync` on an ExternalSecret, `kubernanny.io/requested-at` on an InfisicalStaticSecret. On a cert-manager Certificate a merge patch of its status subresource that sets the `Issuing` condition to True with reason `ManuallyTriggered` (`cmctl renew`)',
    marker: "reason: 'ManuallyTriggered'",
    admission:
      'Flux, External Secrets, Infisical: only an UPDATE that changes nothing but those annotations (spec, labels, the other annotations unchanged). Certificates: only an UPDATE of `certificates/status` that adds or changes the `Issuing` condition to True with reason `ManuallyTriggered`, every other condition and status field unchanged',
  },
  'cleanup-pods': {
    changes:
      'deletes the finished pods the issue lists (phase Failed, evicted ones included, or Succeeded of a Job that is gone; at most 50, one namespace), with their normal grace period',
    marker: '/pods/${enc(pod)}`).then(',
    admission:
      'only a DELETE of a pod whose phase is Failed or Succeeded; no create, no update, never a running or pending pod',
  },
  'force-delete-terminating': {
    changes:
      'off unless named in `actions.enabled`. Deletes the pod the issue names with `gracePeriodSeconds: 0`: a pod in Terminating for over 10 minutes whose node is NotReady or gone (`kubectl delete --force --grace-period=0`). Shares `delete` on pods with `cleanup-pods`',
    marker: 'gracePeriodSeconds: 0',
    admission:
      'rendered only with `actions.enabled: [force-delete-terminating]`: additionally a DELETE of a pod that already has a `deletionTimestamp`. Whether its node is down cannot be checked there; the agent checks it',
  },
  'longhorn-backup': {
    changes:
      'creates one Longhorn `Snapshot` (`createSnapshot: true`) of the volume the issue names and one `Backup` of it (label `backup-volume`), both labelled `app.kubernetes.io/created-by: kubernanny`: the CR way to take a backup now',
    marker: "kind: 'Snapshot'",
    admission:
      'only CREATE of a Snapshot with `createSnapshot: true` naming a volume, and of a Backup naming a snapshot with the `backup-volume` label, both labelled by kubernanny, Backups without `backupMode: full`; no update, no delete',
  },
  'velero-backup': {
    changes:
      'reads the Velero `Schedule` the issue names and creates one `Backup` with its template, named `<schedule>-<timestamp>` and labelled `velero.io/schedule-name`: the same as `velero backup create --from-schedule`',
    marker: "'velero.io/schedule-name': action.schedule",
    admission:
      'only CREATE of a Backup labelled with a schedule name and `app.kubernetes.io/created-by: kubernanny`, without `hooks` (commands run in pods), `resourcePolicy` or `orderedResources`; the agent does not back up a schedule that uses them. The rest cannot be compared with the schedule (which namespaces and resources); Velero writes only to the storage locations already configured',
  },
  'argocd-terminate-op': {
    changes:
      'off unless named in `actions.enabled`. Merge patch of `status.operationState.phase: Terminating` on the Application the issue names, whose sync has run for over 30 minutes: what `argocd app terminate-op` has the API server do. Adds no RBAC verb (the same `patch` as `argocd-sync`), only a branch of the admission policy',
    marker: "status: { operationState: { phase: 'Terminating' } }",
    admission:
      'rendered only with `actions.enabled: [argocd-terminate-op]`: additionally an UPDATE that turns `status.operationState.phase` from Running to Terminating, the rest of the status, the spec and `operation` unchanged',
  },
  'pvc-expand': {
    changes:
      'off unless named in `actions.enabled`. Merge patch of `spec.resources.requests.storage` on the PVC the issue names (85 % full, Bound, its StorageClass with `allowVolumeExpansion`, not a CloudNativePG volume): a quarter more, rounded up to whole Gi. A volume cannot be shrunk again',
    marker: 'spec: { resources: { requests: { storage: action.to } } }',
    admission:
      'rendered only while the action is enabled: only an UPDATE that raises the storage request, by at most half or 1 Gi, with everything else on the claim unchanged',
  },
};

/** The Role in the agent's own namespace, row by row (checked against the chart and install.yaml). */
export const NAMESPACE_ROLE: readonly {
  group?: string;
  resources: string[];
  names: string[];
  verbs: string[];
  holds: string;
}[] = [
  {
    resources: ['secrets'],
    names: ['kubernanny-identity', 'kubernanny-devices'],
    verbs: ['get'],
    holds: "the agent's X25519 key pair; the names and public keys of paired devices",
  },
  {
    resources: ['secrets'],
    names: ['kubernanny-devices'],
    verbs: ['patch'],
    holds: 'adds a device on pairing, removes it on revocation',
  },
  {
    resources: ['configmaps'],
    names: ['kubernanny-settings'],
    verbs: ['get', 'patch'],
    holds: 'the switches set in the app, silenced issues, accepted advisories',
  },
  {
    resources: ['configmaps'],
    names: ['kubernanny-history'],
    verbs: ['get', 'patch'],
    holds:
      'the problem history of the last 7 days and, without Prometheus, the own CPU and memory record, so a restart continues the week; the chart creates it empty, only the pod in charge writes it (at most once a minute and on shutdown). Not rendered with `history.persist: false`',
  },
  {
    resources: ['secrets', 'configmaps'],
    names: [],
    verbs: ['create'],
    holds:
      'creates the two Secrets and `kubernanny-settings` on first start (never `kubernanny-history`, which comes with the chart). Kubernetes RBAC cannot limit `create` by name (the name is not known before the object exists), so this line cannot carry `resourceNames`; the agent only ever creates those three',
  },
  {
    group: 'coordination.k8s.io',
    resources: ['leases'],
    names: ['kubernanny'],
    verbs: ['get', 'patch'],
    holds:
      'which pod is in charge during a rolling update (sends notifications, runs actions, holds the relay): renewed every 2 s, released on shutdown',
  },
  {
    group: 'coordination.k8s.io',
    resources: ['leases'],
    names: [],
    verbs: ['create'],
    holds: 'creates that Lease on first start (again, `create` cannot be limited by name)',
  },
];

/**
 * What the agent never holds, in any switch combination. Each entry is a
 * predicate over one RBAC rule; the spec renders the chart with everything on
 * and runs every rule of install.yaml and the chart through it.
 */
export interface RbacRule {
  apiGroups: string[];
  resources: string[];
  verbs: string[];
  resourceNames?: string[];
}

export const NEVER: readonly { what: string; matches: (r: RbacRule, kind: 'ClusterRole' | 'Role') => boolean }[] = [
  // cleanup-pods and force-delete-terminating delete pods; the admission policy holds that to finished or already terminating ones.
  {
    what: '`deletecollection` on anything, or `delete` on anything but pods (pods only for `cleanup-pods` and `force-delete-terminating`, held to finished or already terminating pods by the admission policy)',
    matches: (r) =>
      r.verbs.includes('deletecollection') ||
      (r.verbs.includes('delete') &&
        !(r.apiGroups.length === 1 && r.apiGroups[0] === '' && r.resources.every((x) => x === 'pods'))),
  },
  // A policy engine's constraint kinds are created by its users, so reading "every resource of constraints.gatekeeper.sh" needs `*`; only for get and list.
  {
    what: 'wildcards (`*`) in API groups or verbs, or a wildcard resource with anything but get and list',
    matches: (r) =>
      [...r.apiGroups, ...r.verbs].includes('*') ||
      (r.resources.includes('*') && r.verbs.some((v) => v !== 'get' && v !== 'list')),
  },
  {
    what: 'Secrets outside its own namespace (no Secret in the ClusterRole at all)',
    matches: (r, kind) => kind === 'ClusterRole' && r.apiGroups.includes('') && r.resources.includes('secrets'),
  },
  {
    what: '`list` or `watch` on Secrets, or `get`/`patch` on a Secret other than its own two',
    matches: (r) =>
      r.resources.includes('secrets') &&
      (r.verbs.some((v) => v === 'list' || v === 'watch') ||
        (r.verbs.some((v) => v !== 'create') && !(r.resourceNames ?? []).length)),
  },
  {
    what: '`pods/exec`, `pods/attach`, `pods/portforward`',
    matches: (r) => r.resources.some((x) => ['pods/exec', 'pods/attach', 'pods/portforward'].includes(x)),
  },
  {
    what: '`services/proxy`, `nodes/proxy`, `pods/proxy` (the API server proxy into the cluster network)',
    matches: (r) => r.resources.some((x) => x.endsWith('/proxy')),
  },
  {
    what: '`escalate`, `bind`, `impersonate`, or any write on RBAC objects',
    matches: (r) =>
      r.verbs.some((v) => ['escalate', 'bind', 'impersonate'].includes(v)) ||
      (r.apiGroups.includes('rbac.authorization.k8s.io') && r.verbs.some((v) => v !== 'get' && v !== 'list')),
  },
  // Jobs only for the opt-in job-rerun.
  {
    what: '`create` of pods or workloads (Jobs only with the opt-in `job-rerun`), `update` of anything',
    matches: (r) =>
      r.verbs.includes('update') ||
      (r.verbs.includes('create') &&
        r.resources.some((x) => ['pods', 'deployments', 'statefulsets', 'daemonsets', 'cronjobs'].includes(x))),
  },
  {
    what: 'anything on nodes but reading them and the `patch` of `uncordon` (held to `spec.unschedulable` by the admission policy): no cordon, drain, label or delete',
    matches: (r) =>
      r.apiGroups.includes('') &&
      r.resources.includes('nodes') &&
      r.verbs.some((v) => !['get', 'list', 'watch', 'patch'].includes(v)),
  },
];
