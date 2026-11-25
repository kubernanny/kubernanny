/** Mirrors the agent's API (agent/src). Keep in step with status.service.ts and views/*.ts there. */
export type Light = 'green' | 'yellow' | 'red' | 'unknown';
export type Severity = 'warning' | 'critical';
/** `info`: a hint. Shown, but never colours the light, costs score or notifies. */
export type IssueSeverity = Severity | 'info';
export type CheckStatus = 'ok' | Severity | 'skipped' | 'error';
export type Tone = 'ok' | 'warning' | 'critical' | 'muted';
export type Health = 'ok' | 'warning' | 'critical';

export type IssueAction =
  | { type: 'argocd-sync'; namespace: string; app: string }
  | { type: 'argocd-refresh'; namespace: string; app: string }
  | { type: 'restart'; kind: string; namespace: string; name: string }
  | { type: 'logs'; namespace: string; pod: string; container?: string; previous?: boolean }
  | { type: 'cnpg-backup'; namespace: string; cluster: string };

export type IssueActionType = IssueAction['type'];
/** Every action type with a switch; `argocd-rollback` stands on its own (the Argo CD sheet), off unless the Helm chart opts in. */
export type ActionType = IssueActionType | 'argocd-rollback';

export interface Issue {
  id: string;
  check: string;
  module: string;
  severity: IssueSeverity;
  title: string;
  cause: string;
  actions: IssueAction[];
  since: string;
  /** Set while someone silenced the issue: shown, but no light, score or notification. */
  silencedUntil?: string;
  /** OSV advisory ids (known vulnerabilities); the app links each to osv.dev. */
  advisories?: string[];
}

export interface Stat {
  label: string;
  value: string;
  tone?: Tone;
}

export interface Link {
  label: string;
  url: string;
}

export type Category =
  | 'core'
  | 'storage'
  | 'gitops'
  | 'database'
  | 'certificates'
  | 'observability'
  | 'networking'
  | 'security'
  | 'maintenance'
  | 'backup'
  | 'platform'
  | 'apps';

export interface ModuleView {
  id: string;
  name: string;
  category: Category;
  icon: string;
  description: string;
  namespace?: string;
  version?: string;
  status: CheckStatus;
  summary: string;
  stats: Stat[];
  links: Link[];
  workloads: { ready: number; total: number; items: { kind: string; namespace: string; name: string; ready: number; desired: number }[] };
  issueIds: string[];
  error?: string;
  /** Vulnerabilities only: advisories someone marked as not applicable. */
  accepted?: AcceptedAdvisory[];
  /** Vulnerabilities only: advisories can be accepted (not locked in Helm). */
  canAccept?: boolean;
  /** Argo CD only, while the rollback is on: manual-sync apps and the deployments they can go back to. */
  rollbacks?: RollbackApp[];
}

/** One manual-sync Argo CD app with its last deployments (agent/src/checks/argocd-rollback.ts). */
export interface RollbackApp {
  namespace: string;
  app: string;
  /** The revision deployed now, short. */
  current?: string;
  /** Newest first. */
  entries: { id: number; revision: string; short: string; deployedAt?: string; current: boolean }[];
}

/** One advisory marked as "does not apply here" on one component, until it expires. */
export interface AcceptedAdvisory {
  component: string;
  name: string;
  advisory: string;
  until: string;
  by: string;
  reason?: string;
}

export interface Overview {
  nodes: { ready: number; total: number };
  pods: { running: number; total: number };
  cpu: { usedMilli: number; allocatableMilli: number } | null;
  memory: { used: number; allocatable: number } | null;
  volumes: { bound: number; total: number };
  ingresses: number;
  namespaces: number;
  workloads: number;
  components: number;
  prometheus: boolean;
  metricsServer: boolean;
}

export interface Snapshot {
  cluster: string;
  /** Missing on agents before 0.3. */
  agentVersion?: string;
  /** Set while a maintenance window holds back notifications (agents from 0.4 on). */
  maintenanceUntil?: string;
  light: Light;
  score: number;
  checkedAt: string | null;
  durationMs: number | null;
  kubernetes: { version?: string; distribution: string } | null;
  overview: Overview | null;
  modules: ModuleView[];
  issues: Issue[];
  error?: string;
  /** Since when the agent's runs fail to read the cluster (agents from 0.3 on); `checkedAt` is then the last good run. */
  failingSince?: string;
}

export interface NodeView {
  name: string;
  roles: string[];
  ready: boolean;
  cordoned: boolean;
  rebooting: boolean;
  kubelet?: string;
  os?: string;
  kernel?: string;
  runtime?: string;
  arch?: string;
  internalIp?: string;
  createdAt?: string;
  cpu: { allocatableMilli: number; requestedMilli: number; usedMilli: number | null };
  memory: { allocatable: number; requested: number; used: number | null };
  disk: number | null;
  pods: { count: number; capacity: number };
  conditions: { type: string; status: string; message?: string }[];
  taints: string[];
}

export interface WorkloadView {
  kind: string;
  namespace: string;
  name: string;
  ready: number;
  desired: number;
  health: Health;
  component?: string;
  images: string[];
  restarts: number;
  createdAt?: string;
  cpuMilli: number | null;
  memBytes: number | null;
  pods: { name: string; node?: string; phase?: string; ready: boolean; restarts: number }[];
}

export interface StorageView {
  classes: { name: string; provisioner?: string; isDefault: boolean; reclaimPolicy?: string; expansion: boolean; volumes: number }[];
  volumes: {
    namespace: string;
    name: string;
    phase?: string;
    storageClass?: string;
    capacity: number;
    accessModes: string[];
    used: number | null;
    usedBy: string[];
    longhorn?: { robustness?: string; state?: string; replicas?: number };
  }[];
}

export interface NetworkView {
  ingresses: {
    namespace: string;
    name: string;
    hosts: string[];
    className?: string;
    tls: boolean;
    certificate?: { name: string; notAfter?: string; daysLeft: number | null; ready: boolean };
    backends: string[];
    component?: string;
  }[];
  loadBalancers: { namespace: string; name: string; addresses: string[]; ports: string[] }[];
}

export interface EventView {
  time: string;
  namespace?: string;
  kind?: string;
  name?: string;
  reason?: string;
  message?: string;
  /** How often it happened, summed over the grouped events. */
  count: number;
  /** When the oldest of the grouped events was first seen (agents from 0.4 on). */
  firstSeen?: string;
  /** How many Event objects the agent merged into this row (1: none). */
  events?: number;
}

/** One episode of an issue (agent/src/views/incidents.ts). */
export interface IncidentView {
  id: string;
  issueId: string;
  title: string;
  severity: 'warning' | 'critical';
  module: string;
  start: string;
  /** null while still open. */
  end: string | null;
  durationMs: number;
  silenced: boolean;
}

export interface IncidentsView {
  /** Since when the agent has watched; nothing before is known. */
  coveredSince: string;
  days: number;
  /** Newest start first. */
  incidents: IncidentView[];
}

export type BackupKind = 'cnpg' | 'longhorn' | 'etcd' | 'velero';
export type BackupState = 'ok' | 'warning' | 'critical';
export type BackupTargetType = 's3' | 'azure' | 'gcs' | 'nfs' | 'cifs' | 'local' | 'unknown';

/** One protected thing and its last success (agent/src/views/backups.ts). */
export interface BackupRow {
  id: string;
  kind: BackupKind;
  name: string;
  namespace?: string;
  lastSuccess: string | null;
  ageMs: number | null;
  state: BackupState;
  note?: string;
  target: { type: BackupTargetType; location?: string } | null;
  count: number | null;
}

export interface BackupTargetView {
  kind: 'longhorn';
  name: string;
  type: BackupTargetType;
  location: string;
  available: boolean | null;
}

export interface BackupsView {
  maxAgeHours: number;
  /** Worst first. */
  rows: BackupRow[];
  targets: BackupTargetView[];
  /** Databases and volumes without any backup; not judged. */
  unprotected: { kind: 'cnpg' | 'longhorn'; name: string; namespace?: string }[];
}

export type Unit = 'ratio' | 'bytesPerSecond' | 'count' | 'seconds';

export interface Series {
  id: string;
  label: string;
  unit: Unit;
  points: [number, number][];
}

export interface HistoryView {
  source: 'prometheus' | 'agent';
  hours: number;
  series: Series[];
}

export interface AgentInfo {
  agentVersion: string;
  cluster: string;
  intervalSeconds: number;
  notifyAfterSeconds: number;
  channels: string[];
  agentKey: string;
  agentFingerprint: string;
  prometheus: boolean;
  components: string[];
  /** The relay the agent dials out to, and whether it is connected; null or missing without one. */
  relay?: { url: string; connected: boolean } | null;
}

export interface Logs {
  pod: string;
  container?: string;
  previous: boolean;
  text: string;
}

export interface ClusterConfig {
  id: string;
  name: string;
  /** Base URL of the agent, e.g. https://kubernanny.example.com (the API is under /api). */
  url: string;
  /** The agent's public key (base64url), pinned at pairing. Every answer must prove it. */
  agentKey: string;
  /** This device's private key for this cluster (base64url). Never sent anywhere. */
  deviceKey: string;
  /** The agent's id for this device, for "this device" in the device list. */
  deviceId: string;
  /** Set for the built-in demo clusters: answered on the device from recordings, never over the network. */
  demo?: 'broken' | 'warning' | 'healthy';
  /** The agent's relay (https), from the pairing link or the agent's /info: used when `url` is out of reach (docs/RELAY.md). */
  relayUrl?: string;
  /** Switched off in the cluster's settings: never use the relay for this cluster. */
  relayOff?: boolean;
  /** Switched off in the cluster's settings: never show this cluster on a home-screen widget (docs/SECURITY.md). */
  widgetOff?: boolean;
  /**
   * Native push to this device is registered with the agent (docs/NOTIFICATIONS.md).
   * `kid` names the push key pair whose secret half is kept natively (never
   * here); `key` is its public half; `token` is the FCM token it was
   * registered with, compared on start to notice a new one.
   */
  push?: { kid: string; key: string; token: string };
}

/** GET /push: whether this device can get native push from the agent, and whether it does. */
export interface AgentPushView {
  /** on: possible. locked: APP_PUSH=off in the deployment. no-relay: the agent has no relay, the only way a push leaves. */
  state: 'on' | 'locked' | 'no-relay';
  /** The relay is connected and delivers push right now. */
  relay: boolean;
  registered: boolean;
}

/** on: runs. off: switched off in the app. locked: switched off in the deployment (Helm), only changeable there. */
export type ToggleState = 'on' | 'off' | 'locked';

export interface ModuleSetting {
  id: string;
  name: string;
  icon: string;
  category: string;
  description: string;
  /** Reads its own resources (a deep check), not only its pods. */
  deep: boolean;
  detected: boolean;
  state: ToggleState;
  /** Off until switched on, because it sends data out of the cluster. */
  defaultOff?: boolean;
  /** What the module sends where, shown next to its switch. */
  privacy?: string;
}

export interface SettingsView {
  modules: ModuleSetting[];
  /** `effect`: what the action may change in the cluster, one line from the agent (missing in agents before 0.4). */
  actions: { type: ActionType; label: string; description: string; effect?: string; state: ToggleState }[];
  notifications: ToggleState;
}

export interface SettingsPatch {
  modules?: Record<string, boolean>;
  actions?: Partial<Record<ActionType, boolean>>;
  notifications?: boolean;
}
