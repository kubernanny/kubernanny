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
  { group: '', resources: ['nodes', 'pods', 'services', 'namespaces', 'events', 'persistentvolumeclaims'], verbs: ['get', 'list', 'watch'], why: 'nodes, pod health, which service belongs to a component, warning events, volumes' },
  { group: 'apps', resources: ['deployments', 'statefulsets', 'daemonsets'], verbs: ['get', 'list', 'watch'], why: 'workload readiness, the owner of a crashing pod, component recognition by image' },
  { group: 'batch', resources: ['jobs', 'cronjobs'], verbs: ['get', 'list', 'watch'], why: 'failed jobs and missed schedules' },
  { group: 'networking.k8s.io', resources: ['ingresses'], verbs: ['get', 'list', 'watch'], why: 'which component is reachable under which address' },
  { group: 'storage.k8s.io', resources: ['storageclasses'], verbs: ['get', 'list', 'watch'], why: 'the Storage tab' },
  { group: 'metrics.k8s.io', resources: ['nodes', 'pods'], verbs: ['get', 'list'], why: 'CPU and memory, when metrics-server runs' },
  { group: 'gateway.networking.k8s.io', resources: ['httproutes'], verbs: ['get', 'list'], why: 'addresses published through the Gateway API' },
  { group: 'traefik.io', resources: ['ingressroutes'], verbs: ['get', 'list'], why: 'addresses published as Traefik IngressRoutes' },
  { group: 'traefik.containo.us', resources: ['ingressroutes'], verbs: ['get', 'list'], why: 'the same, older Traefik API group' },
];

export type WriteActionType = Exclude<ActionType, 'logs'>;

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
      'merge patch of `spec.template.metadata.annotations["kubectl.kubernetes.io/restartedAt"]` on the Deployment, StatefulSet or DaemonSet the issue names: the same as `kubectl rollout restart`',
    marker: 'kubectl.kubernetes.io/restartedAt',
    admission: 'only an UPDATE that changes nothing but that annotation (spec, template spec and labels, the other annotations, metadata compared); no create, no delete',
  },
  'argocd-sync': {
    changes: 'merge patch of `operation` (a sync with `initiatedBy.username: kubernanny`) on the Application the issue names: the same as pressing Sync in Argo CD',
    marker: "initiatedBy: { username: 'kubernanny' }",
    admission: 'only `operation` (a sync initiated by `kubernanny`, without `revision(s)`, `source(s)`, `manifests` or `resources`) and the refresh annotation; spec, status, labels, other annotations unchanged; no create, no delete',
  },
  'argocd-rollback': {
    changes:
      'off unless named in `actions.enabled`. Merge patch of `operation` (a sync with `initiatedBy.username: kubernanny` and `sync.revision` set to an earlier entry of the app\'s own `status.history`, no source, no prune, no options) on a manual-sync, single-source Application the request names: like `argocd app sync --revision`, the app\'s `spec.source` at that revision. Adds no RBAC verb (the same `patch` as `argocd-sync`), only a branch of the admission policy',
    marker: "sync: { revision: decided.revision, syncStrategy: { hook: {} } }",
    admission:
      'rendered only with `actions.enabled: [argocd-rollback]`: additionally a sync initiated by `kubernanny` whose `revision` is the revision of an entry in the stored `status.history` with the same repository as `spec.source`, on an app without automated sync and with a single `spec.source`; no `revisions`, `source(s)`, `manifests`, `resources`, `prune`, `dryRun`, `syncOptions`, `retry`, `apply` or `force`, `info` only `Reason`',
  },
  'argocd-refresh': {
    changes: 'merge patch of the annotation `argocd.argoproj.io/refresh: hard` on the Application the issue names: the same as a hard refresh in Argo CD',
    marker: "'argocd.argoproj.io/refresh': 'hard'",
    admission: 'the same policy as `argocd-sync`: the refresh annotation set to `hard` or `normal`, nothing else',
  },
  'cnpg-backup': {
    changes: 'creates one `Backup` object (`generateName: <cluster>-kubernanny-`, label `app.kubernetes.io/created-by: kubernanny`) for the database cluster the issue names: the same as `kubectl cnpg backup`',
    marker: "kind: 'Backup'",
    admission: 'only CREATE of a Backup naming a cluster, without `method`, `target`, `online`, `onlineConfiguration` or `pluginConfiguration`; whether the cluster exists is not checked (CNPG fails such a Backup)',
  },
};

/** The Role in the agent's own namespace, row by row (checked against the chart and install.yaml). */
export const NAMESPACE_ROLE: readonly { group?: string; resources: string[]; names: string[]; verbs: string[]; holds: string }[] = [
  { resources: ['secrets'], names: ['kubernanny-identity', 'kubernanny-devices'], verbs: ['get'], holds: 'the agent\'s X25519 key pair; the names and public keys of paired devices' },
  { resources: ['secrets'], names: ['kubernanny-devices'], verbs: ['patch'], holds: 'adds a device on pairing, removes it on revocation' },
  { resources: ['configmaps'], names: ['kubernanny-settings'], verbs: ['get', 'patch'], holds: 'the switches set in the app, silenced issues, accepted advisories' },
  {
    resources: ['secrets', 'configmaps'],
    names: [],
    verbs: ['create'],
    holds: 'creates the three objects above on first start. Kubernetes RBAC cannot limit `create` by name (the name is not known before the object exists), so this line cannot carry `resourceNames`; the agent only ever creates those three',
  },
  {
    group: 'coordination.k8s.io',
    resources: ['leases'],
    names: ['kubernanny'],
    verbs: ['get', 'patch'],
    holds: 'which pod is in charge during a rolling update (sends notifications, runs actions, holds the relay): renewed every 2 s, released on shutdown',
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
  { what: '`delete` or `deletecollection` on anything', matches: (r) => r.verbs.some((v) => v === 'delete' || v === 'deletecollection') },
  // A policy engine's constraint kinds are created by its users, so reading "every resource of constraints.gatekeeper.sh" needs `*`; only for get and list.
  {
    what: 'wildcards (`*`) in API groups or verbs, or a wildcard resource with anything but get and list',
    matches: (r) => [...r.apiGroups, ...r.verbs].includes('*') || (r.resources.includes('*') && r.verbs.some((v) => v !== 'get' && v !== 'list')),
  },
  { what: 'Secrets outside its own namespace (no Secret in the ClusterRole at all)', matches: (r, kind) => kind === 'ClusterRole' && r.apiGroups.includes('') && r.resources.includes('secrets') },
  { what: '`list` or `watch` on Secrets, or `get`/`patch` on a Secret other than its own two', matches: (r) => r.resources.includes('secrets') && (r.verbs.some((v) => v === 'list' || v === 'watch') || (r.verbs.some((v) => v !== 'create') && !(r.resourceNames ?? []).length)) },
  { what: '`pods/exec`, `pods/attach`, `pods/portforward`', matches: (r) => r.resources.some((x) => ['pods/exec', 'pods/attach', 'pods/portforward'].includes(x)) },
  { what: '`services/proxy`, `nodes/proxy`, `pods/proxy` (the API server proxy into the cluster network)', matches: (r) => r.resources.some((x) => x.endsWith('/proxy')) },
  { what: '`escalate`, `bind`, `impersonate`, or any write on RBAC objects', matches: (r) => r.verbs.some((v) => ['escalate', 'bind', 'impersonate'].includes(v)) || (r.apiGroups.includes('rbac.authorization.k8s.io') && r.verbs.some((v) => v !== 'get' && v !== 'list')) },
  { what: '`create` of pods or workloads, `update` of anything', matches: (r) => r.verbs.includes('update') || (r.verbs.includes('create') && r.resources.some((x) => ['pods', 'deployments', 'statefulsets', 'daemonsets', 'jobs', 'cronjobs'].includes(x))) },
  { what: 'anything on nodes but reading them (no cordon, drain or label)', matches: (r) => r.apiGroups.includes('') && r.resources.includes('nodes') && r.verbs.some((v) => v !== 'get' && v !== 'list' && v !== 'watch') },
];
