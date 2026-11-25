import { IssueActionType } from '../checks/types';
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

/** The static ClusterRole lines of `templates/rbac.yaml`: what every run reads, whatever is switched off. */
export const INVENTORY_READS: readonly ExplainedRule[] = [
  { group: '', resources: ['nodes', 'pods', 'services', 'namespaces', 'events', 'persistentvolumeclaims'], verbs: ['get', 'list'], why: 'nodes, pod health, which service belongs to a component, warning events, volumes' },
  { group: 'apps', resources: ['deployments', 'statefulsets', 'daemonsets'], verbs: ['get', 'list'], why: 'workload readiness, the owner of a crashing pod, component recognition by image' },
  { group: 'batch', resources: ['jobs', 'cronjobs'], verbs: ['get', 'list'], why: 'failed jobs and missed schedules' },
  { group: 'networking.k8s.io', resources: ['ingresses'], verbs: ['get', 'list'], why: 'which component is reachable under which address' },
  { group: 'storage.k8s.io', resources: ['storageclasses'], verbs: ['get', 'list'], why: 'the Storage tab' },
  { group: 'metrics.k8s.io', resources: ['nodes', 'pods'], verbs: ['get', 'list'], why: 'CPU and memory, when metrics-server runs' },
  { group: 'gateway.networking.k8s.io', resources: ['httproutes'], verbs: ['get', 'list'], why: 'addresses published through the Gateway API' },
  { group: 'traefik.io', resources: ['ingressroutes'], verbs: ['get', 'list'], why: 'addresses published as Traefik IngressRoutes' },
  { group: 'traefik.containo.us', resources: ['ingressroutes'], verbs: ['get', 'list'], why: 'the same, older Traefik API group' },
];

export type WriteActionType = Exclude<IssueActionType, 'logs'>;

/** What each write action changes, exactly as `actions/actions.service.ts` sends it (the spec checks the strings are there). */
export const WRITE_EFFECTS: Record<WriteActionType, { changes: string; marker: string }> = {
  restart: {
    changes:
      'merge patch of `spec.template.metadata.annotations["kubectl.kubernetes.io/restartedAt"]` on the Deployment, StatefulSet or DaemonSet the issue names: the same as `kubectl rollout restart`',
    marker: 'kubectl.kubernetes.io/restartedAt',
  },
  'argocd-sync': {
    changes: 'merge patch of `operation` (a sync with `initiatedBy.username: kubernanny`) on the Application the issue names: the same as pressing Sync in Argo CD',
    marker: "initiatedBy: { username: 'kubernanny' }",
  },
  'argocd-refresh': {
    changes: 'merge patch of the annotation `argocd.argoproj.io/refresh: hard` on the Application the issue names: the same as a hard refresh in Argo CD',
    marker: "'argocd.argoproj.io/refresh': 'hard'",
  },
  'cnpg-backup': {
    changes: 'creates one `Backup` object (`generateName: <cluster>-kubernanny-`, label `app.kubernetes.io/created-by: kubernanny`) for the database cluster the issue names: the same as `kubectl cnpg backup`',
    marker: "kind: 'Backup'",
  },
};

/** The Role in the agent's own namespace, row by row (checked against the chart and install.yaml). */
export const NAMESPACE_ROLE: readonly { resources: string[]; names: string[]; verbs: string[]; holds: string }[] = [
  { resources: ['secrets'], names: ['kubernanny-identity', 'kubernanny-devices'], verbs: ['get'], holds: 'the agent\'s X25519 key pair; the names and public keys of paired devices' },
  { resources: ['secrets'], names: ['kubernanny-devices'], verbs: ['patch'], holds: 'adds a device on pairing, removes it on revocation' },
  { resources: ['configmaps'], names: ['kubernanny-settings'], verbs: ['get', 'patch'], holds: 'the switches set in the app, silenced issues, accepted advisories' },
  {
    resources: ['secrets', 'configmaps'],
    names: [],
    verbs: ['create'],
    holds: 'creates the three objects above on first start. Kubernetes RBAC cannot limit `create` by name (the name is not known before the object exists), so this line cannot carry `resourceNames`; the agent only ever creates those three',
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
  { what: 'anything on nodes but reading them (no cordon, drain or label)', matches: (r) => r.apiGroups.includes('') && r.resources.includes('nodes') && r.verbs.some((v) => v !== 'get' && v !== 'list') },
];
