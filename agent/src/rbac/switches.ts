import { WRITE_ACTIONS } from './rules';

/**
 * The deployment-level switches of the Helm chart that are not per module or
 * per action (those rows are generated from files/rbac.json), and what each
 * one takes away. docs/PERMISSIONS.md renders them as the "switch -> what is
 * removed" matrix; `permissions-doc.spec.ts` fails when values.yaml gains a
 * switch (`enabled`, `allow*`, `disabled`) that is not listed here.
 *
 * `hard`: the app cannot undo it. A soft default (vulnerabilities.enabled)
 * is listed too, with the hard switch that does make it impossible.
 */
export interface HardSwitch {
  /** The path in values.yaml. */
  value: string;
  /** The setting that removes something, as you would write it. */
  set: string;
  hard: boolean;
  rbac?: string;
  routes?: string;
  outbound?: string;
  other?: string;
}

export const SWITCHES: readonly HardSwitch[] = [
  {
    value: 'rbac.allowActions',
    set: 'rbac.allowActions: false',
    hard: true,
    rbac: 'every `patch` and `create` in the ClusterRole (every write action is added to `actions.disabled`, `argocd-rollback` too, whatever `actions.enabled` says)',
    routes: `\`POST /api/actions/<type>\` answers 403 \`ACTION_DISABLED\` for ${WRITE_ACTIONS.filter((a) => a !== 'argocd-rollback').join(', ')}; \`POST /api/argocd/rollback\` likewise`,
    other: 'the app shows those action switches as locked',
  },
  {
    value: 'checks.disabled',
    set: 'checks.disabled: [notifications]',
    hard: true,
    outbound:
      'no message through any channel (ntfy, the webhook, app push): issue notifications, security alerts, the weekly report and the test message are not sent; the chart does not even pass NTFY_URL, WEBHOOK_URL or the existing Secret to the agent',
    routes: '`POST /api/notify/test` answers 403 `NOTIFICATIONS_LOCKED`',
    other:
      'the app shows notifications as locked. `checks.disabled: [prometheus]` likewise means no request to Prometheus from any module or view, not only the Prometheus module',
  },
  {
    value: 'rbac.admissionPolicy.enabled',
    set: 'rbac.admissionPolicy.enabled: true (default)',
    hard: true,
    other:
      "adds ValidatingAdmissionPolicies (Kubernetes 1.30+) that deny every request of the agent's ServiceAccount on workloads, Argo CD Applications and CNPG Backups beyond what its actions change (see the write table). false: the RBAC rules alone apply. Rendered only while a write action is enabled",
  },
  {
    value: 'actions.disabled',
    set: 'actions.disabled: [<type>]',
    hard: true,
    rbac: 'the permission of that action, unless another enabled action needs the same one (see the per-action table)',
    routes: 'the action route answers 403 `ACTION_DISABLED`; issues no longer offer the action',
  },
  {
    value: 'actions.enabled',
    set: 'actions.enabled: [] (default)',
    hard: true,
    routes:
      '`POST /api/argocd/rollback` answers 403 `ACTION_DISABLED` before reading anything; the Argo CD sheet lists no history',
    other:
      'the opt-in action types stay locked in the app. `[argocd-rollback]` turns the rollback on: no new RBAC verb (it shares `patch` on Applications with `argocd-sync`), but the admission policy gains the branch that lets the agent sync a manual-sync app to a revision from its own history; without it that branch is not rendered and a sync with a `revision` is denied. `actions.disabled` and `rbac.allowActions: false` win over it. Ids other than the opt-in ones fail the install',
  },
  {
    value: 'vulnerabilities.enabled',
    set: 'vulnerabilities.enabled: false (default)',
    hard: false,
    outbound:
      'no request to the vulnerability database until someone switches the module on in the app. To make that impossible: `checks.disabled: [vulnerabilities]`',
  },
  {
    value: 'imageUpdates.enabled',
    set: 'imageUpdates.enabled: false (default)',
    hard: false,
    outbound:
      'no request to any container registry until someone switches the module on in the app, and no NetworkPolicy egress rule for registries. To make that impossible: `checks.disabled: [image-updates]` (also drops the egress rule)',
  },
  {
    value: 'vulnerabilities.allowAccept',
    set: 'vulnerabilities.allowAccept: false',
    hard: true,
    routes:
      '`POST /api/vulnerabilities/accept` and `/unaccept` answer 403 `ACCEPT_LOCKED` before reading or writing anything',
    other: 'stored acceptances are ignored, every advisory counts again; the app hides the Accept button',
  },
  {
    value: 'relay.enabled',
    set: 'relay.enabled: false (default)',
    hard: true,
    outbound: 'no `RELAY_URL`: no WebSocket to the relay, and no NetworkPolicy egress rule for it',
  },
  {
    value: 'notifications.weeklyDigest.enabled',
    set: 'notifications.weeklyDigest.enabled: false (default)',
    hard: true,
    outbound: 'no weekly report through the notification channels',
  },
  {
    value: 'notifications.appPush.enabled',
    set: 'notifications.appPush.enabled: false',
    hard: true,
    routes:
      '`POST` and `DELETE /api/push/register` and `POST /api/push/test` answer 404 `PUSH_OFF` before reading or writing anything',
    outbound: 'no Push frame on the relay connection: the agent never hands a push to the relay',
    other: 'push tokens stored earlier are deleted from `kubernanny-devices` on start; the app shows push as locked',
  },
  {
    value: 'notifications.appPush.deadman.enabled',
    set: 'notifications.appPush.deadman.enabled: false',
    hard: true,
    outbound:
      "no Deposit frame with dead man's switch messages on the relay connection (the first frame of each connection clears what an earlier run left)",
    other: 'the app shows "Warn when the agent goes silent" as switched off in the deployment',
  },
  {
    value: 'history.persist',
    set: 'history.persist: false',
    hard: true,
    rbac: '`get` and `patch` on the ConfigMap `kubernanny-history` in the Role',
    other:
      'no ConfigMap `kubernanny-history`: the problem history, the weekly report and the own CPU and memory record live in memory only and start again with every restart or rollout',
  },
  {
    value: 'ingress.enabled',
    set: 'ingress.enabled: false (default)',
    hard: true,
    other: 'no Ingress object: the agent is reachable only inside the cluster (or through the relay)',
  },
  {
    value: 'serviceMonitor.enabled',
    set: 'serviceMonitor.enabled: false (default)',
    hard: true,
    other: 'no ServiceMonitor; `/metrics` on port 9100 stays, without names',
  },
  {
    value: 'networkPolicy.enabled',
    set: 'networkPolicy.enabled: true',
    hard: true,
    other:
      'adds a NetworkPolicy: port 8080 only from the ingress controller namespace, 9100 only from the monitoring namespace',
  },
  {
    value: 'networkPolicy.egress.enabled',
    set: 'networkPolicy.egress.enabled: true',
    hard: true,
    outbound: 'everything except DNS, the API server, the monitoring namespace and the HTTPS rules below',
  },
  {
    value: 'networkPolicy.egress.internetHttps',
    set: 'networkPolicy.egress.internetHttps: false',
    hard: true,
    outbound:
      'with egress on: HTTPS to the internet (notifications to public services, api.osv.dev). Only together with `networkPolicy.egress.apiServerCIDRs`: without it the API-server rule allows its ports, 443 included, to any address',
  },
];
