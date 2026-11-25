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
    rbac: 'every `patch` and `create` in the ClusterRole (the four write actions are added to `actions.disabled`)',
    routes: '`POST /api/actions/<type>` answers 403 `ACTION_DISABLED` for restart, argocd-sync, argocd-refresh, cnpg-backup',
    other: 'the app shows those action switches as locked',
  },
  {
    value: 'checks.disabled',
    set: 'checks.disabled: [notifications]',
    hard: true,
    outbound: 'no message to ntfy or the webhook: issue notifications and security alerts are not sent',
    other: 'the app shows notifications as locked',
  },
  {
    value: 'actions.disabled',
    set: 'actions.disabled: [<type>]',
    hard: true,
    rbac: 'the permission of that action, unless another enabled action needs the same one (see the per-action table)',
    routes: 'the action route answers 403 `ACTION_DISABLED`; issues no longer offer the action',
  },
  {
    value: 'vulnerabilities.enabled',
    set: 'vulnerabilities.enabled: false (default)',
    hard: false,
    outbound: 'no request to the vulnerability database until someone switches the module on in the app. To make that impossible: `checks.disabled: [vulnerabilities]`',
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
    routes: '`POST /api/vulnerabilities/accept` and `/unaccept` answer 403 `ACCEPT_LOCKED` before reading or writing anything',
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
    routes: '`POST` and `DELETE /api/push/register` and `POST /api/push/test` answer 404 `PUSH_OFF` before reading or writing anything',
    outbound: 'no Push frame on the relay connection: the agent never hands a push to the relay',
    other: 'push tokens stored earlier are deleted from `kubernanny-devices` on start; the app shows push as locked',
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
    other: 'adds a NetworkPolicy: port 8080 only from the ingress controller namespace, 9100 only from the monitoring namespace',
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
    outbound: 'with egress on: HTTPS to the internet (notifications to public services, api.osv.dev)',
  },
];
