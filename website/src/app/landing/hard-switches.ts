/**
 * The hard switches of the Helm chart, as the landing page shows them: what
 * each one makes impossible, not just hidden. `hard-switches.spec.ts` checks
 * every `value` against deploy/helm/kubernanny/values.yaml (and its default),
 * so a renamed value breaks the build instead of the page quietly lying.
 * The full matrix, generated from the agent's code, is docs/PERMISSIONS.md.
 */
export type Removed = 'write' | 'read' | 'route' | 'outbound' | 'data';

export interface HardSwitch {
  /** What a person wants to rule out, in their words. */
  goal: string;
  /** The Helm setting, as written in values.yaml. */
  setting: string;
  /** Dotted path into values.yaml, checked by the spec. */
  value: string;
  /** The default in values.yaml, checked by the spec (`null` when the setting is a list). */
  default: boolean | null;
  /** What is gone once it is set. */
  removes: Removed[];
  detail: string;
}

export const REMOVED_LABEL: Record<Removed, string> = {
  write: 'write permission',
  read: 'read permission',
  route: 'API route',
  outbound: 'outbound connection',
  data: 'stored data',
};

export const HARD_SWITCHES: HardSwitch[] = [
  {
    goal: 'Never change anything in my cluster',
    setting: 'rbac.allowActions: false',
    value: 'rbac.allowActions',
    default: true,
    removes: ['write', 'route'],
    detail: 'The ClusterRole loses every patch and create verb, and the action routes answer 403. Strictly read-only.',
  },
  {
    goal: 'No restarts, but syncs are fine',
    setting: 'actions.disabled: [restart]',
    value: 'actions.disabled',
    default: null,
    removes: ['write', 'route'],
    detail: 'Each action alone: restart, argocd-sync, argocd-refresh, cnpg-backup, logs. Its permission leaves the RBAC once nothing else needs it.',
  },
  {
    goal: 'Do not look into Argo CD',
    setting: 'checks.disabled: [argocd]',
    value: 'checks.disabled',
    default: null,
    removes: ['read', 'write'],
    detail: 'Any module by its id. It never runs, and the chart grants no permission to read its resources or to run its actions.',
  },
  {
    goal: 'No connection out of the cluster',
    setting: 'relay.enabled: false (default)',
    value: 'relay.enabled',
    default: false,
    removes: ['outbound'],
    detail: 'No WebSocket to any relay, and no egress rule for it in the NetworkPolicy. The app reaches the agent directly or not at all.',
  },
  {
    goal: 'Do not tell anyone which versions I run',
    setting: 'checks.disabled: [vulnerabilities]',
    value: 'checks.disabled',
    default: null,
    removes: ['outbound'],
    detail: 'The lookup is off by default; listed here, the app cannot switch it on either, and no request ever goes to OSV.dev or a mirror.',
  },
  {
    goal: 'Do not ask registries about my images',
    setting: 'checks.disabled: [image-updates]',
    value: 'checks.disabled',
    default: null,
    removes: ['outbound'],
    detail: 'The update lookup is off by default; listed here it cannot be switched on from the app, and no registry is ever contacted.',
  },
  {
    goal: 'Nobody may wave a vulnerability through',
    setting: 'vulnerabilities.allowAccept: false',
    value: 'vulnerabilities.allowAccept',
    default: true,
    removes: ['route', 'data'],
    detail: 'Marking an advisory as not applicable is refused before anything is stored, and acceptances stored earlier are ignored.',
  },
  {
    goal: 'No push through Google to my phone',
    setting: 'notifications.appPush.enabled: false',
    value: 'notifications.appPush.enabled',
    default: true,
    removes: ['route', 'data', 'outbound'],
    detail: 'The push routes answer 404, stored push tokens are deleted on start, and nothing is handed to the relay. Even when on, pushes are sealed per device: the relay and Google never see the text.',
  },
  {
    goal: 'No notifications at all',
    setting: 'checks.disabled: [notifications]',
    value: 'checks.disabled',
    default: null,
    removes: ['outbound'],
    detail: 'Nothing is sent to ntfy, webhooks or phones, including the alerts about security-relevant changes.',
  },
];
