/** Mirrors the agent's API (agent/src). Keep in step with status/snapshot.ts and views/*.ts there; agent/drift/app-model.ts fails the agent's typecheck and tests when it drifts. */
export type Light = 'green' | 'yellow' | 'red' | 'unknown';
export type Severity = 'warning' | 'critical';
/** `info`: a hint. Shown, but never colours the light, costs score or notifies. */
export type IssueSeverity = Severity | 'info';
export type CheckStatus = 'ok' | Severity | 'skipped' | 'error';
export type Tone = 'ok' | 'warning' | 'critical' | 'muted';
export type Health = 'ok' | 'warning' | 'critical';

/** A resource of an Argo CD app. */
export interface SyncResource {
  kind: string;
  name: string;
  namespace?: string;
}

/** What a sync of one app may do beyond a plain one (agent/src/checks/argocd-sync-offer.ts). */
export interface SyncOffer {
  /** What a sync with prune deletes: in the cluster, no longer in Git. */
  prune: SyncResource[];
  /** More to prune than listed: prune is not offered. */
  pruneMore?: boolean;
  /** Server-Side Apply is in effect already. */
  serverSide: boolean;
  /** The last sync failed because Kubernetes refused a change. */
  failure?: { kind: 'duplicate' | 'immutable' | 'invalid'; message: string };
  canPrune: boolean;
  canReplace: boolean;
}

/** What the app sends with a sync (`POST /actions/argocd-sync`). */
export interface SyncOptions {
  /** The confirmed resources to delete, as `Kind/namespace/name`. */
  prune?: string[];
  serverSideApply?: boolean;
  replace?: boolean;
}

export type IssueAction =
  | { type: 'argocd-sync'; namespace: string; app: string; offer?: SyncOffer }
  | { type: 'argocd-refresh'; namespace: string; app: string }
  /** `secondary`: after the logs, with a hint (a crash loop). `changed`: a ConfigMap of the environment changed since the start, so the restart is the fix. */
  | {
      type: 'restart';
      kind: string;
      namespace: string;
      name: string;
      secondary?: boolean;
      changed?: { kind: string; name: string };
    }
  | { type: 'logs'; namespace: string; pod: string; container?: string; previous?: boolean }
  | { type: 'cnpg-backup'; namespace: string; cluster: string }
  | { type: 'uncordon'; node: string }
  | { type: 'job-rerun'; namespace: string; from: 'CronJob' | 'Job'; name: string }
  | { type: 'job-delete'; namespace: string; job: string; uid: string }
  | { type: 'reconcile-now'; kind: string; namespace: string; name: string }
  | { type: 'cleanup-pods'; namespace: string; pods: string[] }
  | {
      type: 'force-delete-terminating';
      namespace: string;
      pod: string;
      node: string;
      statefulSet?: string;
    }
  | { type: 'longhorn-backup'; namespace: string; volume: string; label: string }
  | { type: 'velero-backup'; namespace: string; schedule: string }
  | { type: 'argocd-terminate-op'; namespace: string; app: string }
  | {
      type: 'pvc-expand';
      namespace: string;
      name: string;
      from: string;
      to: string;
      template?: string;
    };

export type IssueActionType = IssueAction['type'];
/** Every action type with a switch; `argocd-rollback` stands on its own (the Argo CD sheet), off unless the Helm chart opts in. */
export type ActionType =
  | IssueActionType
  | 'argocd-rollback'
  | 'config-change-hint'
  | 'argocd-sync-prune'
  | 'argocd-sync-replace';

export interface Issue {
  id: string;
  check: string;
  module: string;
  severity: IssueSeverity;
  title: string;
  cause: string;
  actions: IssueAction[];
  /** Actions that would fit but are switched off, with why (agents from 0.4.0 on). */
  unavailable?: UnavailableAction[];
  since: string;
  /** Set while someone silenced the issue: shown, but no light, score or notification. */
  silencedUntil?: string;
  /** OSV advisory ids (known vulnerabilities); the app links each to osv.dev. */
  advisories?: string[];
}

/** Why an action is off: in the app (`off`), or locked in the deployment as opt-in or explicitly disabled. */
export type ActionLock = { state: 'off' } | { state: 'locked'; lockedBy: 'opt-in' | 'disabled' };

/** A switched-off action an issue would offer: no target, only what it is and why it is off. */
export type UnavailableAction = {
  type: IssueAction['type'];
  label: string;
  description: string;
} & ActionLock;

export interface Stat {
  label: string;
  value: string;
  tone?: Tone;
}

export interface Link {
  label: string;
  url: string;
}

/** A small fact under a detail row's name, tinted when it is the problem. */
export interface DetailMeta {
  text: string;
  tone?: Tone;
}

/** One object of a module (agent/src/modules/types.ts, `DetailRow`). */
export interface DetailRow {
  name: string;
  sub?: string;
  tone: Tone;
  value?: string;
  meta?: DetailMeta[];
  /** A workload's pods, shown indented under it. */
  children?: DetailRow[];
}

/** A structured part of a module sheet: its objects as a list or a short table. */
export type DetailSection =
  | { title: string; kind: 'list'; rows: DetailRow[]; more?: number; role?: 'runtime' }
  | {
      title: string;
      kind: 'table';
      columns: string[];
      rows: { cells: string[]; tone: Tone }[];
      more?: number;
    };

/** One copy of a component installed several times (Redis/Valkey per app). */
export interface ComponentInstance {
  namespace: string;
  name: string;
  version?: string;
  ready: number;
  desired: number;
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
  /** Two to four key figures. */
  stats: Stat[];
  /** The module's objects, problems first; absent for modules without a list. */
  details?: DetailSection[];
  instances?: ComponentInstance[];
  links: Link[];
  workloads: {
    ready: number;
    total: number;
    items: { kind: string; namespace: string; name: string; ready: number; desired: number }[];
  };
  issueIds: string[];
  error?: string;
  /** Vulnerabilities only: advisories someone marked as not applicable. */
  accepted?: AcceptedAdvisory[];
  /** Vulnerabilities only: advisories can be accepted (not locked in Helm). */
  canAccept?: boolean;
  /** Security posture only: hints accepted in the workloads' `kubernanny.io/accept` annotation. */
  acceptedFindings?: AcceptedFinding[];
  /** Argo CD only, while the rollback is on: manual-sync apps and the deployments they can go back to. */
  rollbacks?: RollbackApp[];
  /** Argo CD only: manual apps with a change waiting. */
  pendingSyncs?: PendingSync[];
}

/** A manual Argo CD app with a change waiting in Git (agent/src/checks/argocd-pending.ts): routine, not an issue. */
export interface PendingSync {
  /** The id its sync runs under, as an action. */
  id: string;
  namespace: string;
  app: string;
  project?: string;
  destination?: string;
  lastSyncAt?: string;
  syncedRevision?: string;
  targetRevision?: string;
  resources: {
    kind: string;
    name: string;
    namespace?: string;
    change: 'update' | 'new' | 'prune';
  }[];
  images: { from: string; to: string }[];
  /** The agent offers the sync (argocd-sync is on). */
  canSync: boolean;
  /** Sync options (agents before sync options send none). */
  offer?: SyncOffer;
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

/** A security hint a workload accepts in Git (agent/src/modules/security/evaluate.ts): counted nowhere, listed folded. */
export interface AcceptedFinding {
  /** The annotation key: root, host-access, no-memory-limit, mutable-image, cpu-throttled. */
  key: string;
  /** What was found, in words. */
  finding: string;
  namespace: string;
  kind: string;
  name: string;
  reason: string;
  /** The workload's own annotation, or its pod template's. */
  source: 'workload' | 'pod-template';
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
  /** Requests and limits where the pods set them. */
  cpu: {
    usedMilli: number;
    allocatableMilli: number;
    requestedMilli?: number;
    limitMilli?: number;
  } | null;
  memory: { used: number; allocatable: number; requested?: number; limit?: number } | null;
  volumes: { bound: number; total: number };
  ingresses: number;
  namespaces: number;
  workloads: number;
  components: number;
  prometheus: boolean;
  metricsServer: boolean;
  /** Per node: use, requests and limits of its pods against allocatable. */
  perNode?: {
    name: string;
    cpu: {
      usedMilli: number | null;
      allocatableMilli: number;
      requestedMilli: number;
      limitMilli: number;
    };
    memory: { used: number | null; allocatable: number; requested: number; limit: number };
    podsWithoutLimit: { cpu: number; memory: number };
  }[];
}

export interface Snapshot {
  cluster: string;
  agentVersion: string;
  /** The image tag and git commit of the agent (CI builds only). */
  agentBuild?: string;
  agentCommit?: string;
  /** Set while a maintenance window holds back notifications. */
  maintenanceUntil?: string;
  light: Light;
  score: number;
  checkedAt: string | null;
  /** When the agent runs its next scheduled check; without it (before the first run) the app shows no countdown. */
  nextCheckAt?: string;
  durationMs: number | null;
  kubernetes: { version?: string; distribution: string } | null;
  overview: Overview | null;
  modules: ModuleView[];
  issues: Issue[];
  error?: string;
  /** Since when the agent's runs fail to read the cluster; `checkedAt` is then the last good run. */
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
  /** Requests and limits summed over the pods on the node (limits only where set). */
  cpu: {
    allocatableMilli: number;
    requestedMilli: number;
    limitMilli: number;
    usedMilli: number | null;
  };
  memory: { allocatable: number; requested: number; limit: number; used: number | null };
  disk: number | null;
  pods: { count: number; capacity: number };
  /** Pods with a container that sets no CPU / memory limit. */
  podsWithoutLimit: { cpu: number; memory: number };
  conditions: { type: string; status: string; message?: string; since?: string }[];
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
  /** Requests and limits of its pods (a limit is null when no container sets one). */
  resources: {
    cpuRequestMilli: number;
    cpuLimitMilli: number | null;
    memRequest: number;
    memLimit: number | null;
    cpuUnlimited: number;
    memUnlimited: number;
  };
  /** The most recent restart of any of its containers; absent when none restarted. */
  lastRestart?: Termination & { pod: string; container: string };
  pods: {
    name: string;
    node?: string;
    phase?: string;
    ready: boolean;
    restarts: number;
    containers?: ContainerView[];
  }[];
}

/** How a container's previous run ended (`lastState.terminated`); `memLimit` only for an OOMKill. */
export interface Termination {
  reason?: string;
  exitCode?: number;
  signal?: number;
  finishedAt?: string;
  memLimit?: number;
}

export interface ContainerView {
  name: string;
  ready: boolean;
  restarts: number;
  waiting?: string;
  lastTermination?: Termination;
}

export interface StorageView {
  classes: {
    name: string;
    provisioner?: string;
    isDefault: boolean;
    reclaimPolicy?: string;
    expansion: boolean;
    volumes: number;
  }[];
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
    /** "Kind/name" of the workloads behind the backends. */
    workloads: string[];
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
  /** When the oldest of the grouped events was first seen. */
  firstSeen: string;
  /** How many Event objects the agent merged into this row (1: none). */
  events?: number;
  /** The workload behind the object, when there is one. */
  workload?: { kind: string; name: string };
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
  /**
   * Flapping (newer agents only): the issue came and went this many times, each
   * time shorter than a notification waits, and the episode spans them.
   */
  flaps?: number;
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
  /** Backups of volumes deleted since; they protect nothing and are only counted. */
  orphaned?: { kind: 'longhorn'; volumes: number; backups: number };
}

export type Unit = 'ratio' | 'bytesPerSecond' | 'count' | 'seconds';

export interface Series {
  id: string;
  label: string;
  unit: Unit;
  points: [number, number][];
  /** Only from the agent's own record: the peak of each point's 5-minute buckets (`points` is their average). */
  max?: [number, number][];
}

export interface HistoryView {
  /** prometheus: queried from Prometheus; agent: CPU and RAM the agent recorded itself, a week in 5-minute buckets. */
  source: 'prometheus' | 'agent';
  hours: number;
  /** Only from the agent's own record: seconds per point. */
  stepSeconds?: number;
  series: Series[];
}

export interface AgentInfo {
  agentVersion: string;
  agentBuild?: string;
  agentCommit?: string;
  cluster: string;
  intervalSeconds: number;
  notifyAfterSeconds: number;
  channels: string[];
  agentKey: string;
  agentFingerprint: string;
  prometheus: boolean;
  components: string[];
  /** The relay the agent dials out to, and whether it is connected; null without one. */
  relay: { url: string; connected: boolean } | null;
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
   * registered with, compared on start to notice a new one. `widget`: the
   * agent was told this device has a home-screen widget showing the cluster
   * (it then sends a silent status push about hourly); absent means no.
   */
  push?: {
    kid: string;
    key: string;
    token: string;
    widget?: true;
    /**
     * The dead man's switch as this device registered it (docs/NOTIFICATIONS.md,
     * "When the agent goes silent"): the grace in minutes, or false when
     * switched off. Absent: registered by an app before it; the next start
     * registers again with the default (on, 15 minutes).
     */
    deadman?: number | false;
  };
}

/** GET /push: whether this device can get native push from the agent, and whether it does. */
export interface AgentPushView {
  /** on: possible. locked: APP_PUSH=off in the deployment. no-relay: the agent has no relay, the only way a push leaves. */
  state: 'on' | 'locked' | 'no-relay';
  /** The relay is connected and delivers push right now. */
  relay: boolean;
  registered: boolean;
  /**
   * The dead man's switch. state on: available; locked: DEADMAN=off in the
   * deployment; relay: the connected relay does not hold deposits. grace:
   * this device's choice, null when off.
   */
  deadman: { state: 'on' | 'locked' | 'relay'; grace: number | null };
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
  /** `effect`: what the action may change in the cluster, one line from the agent. */
  actions: {
    type: ActionType;
    label: string;
    description: string;
    effect: string;
    state: ToggleState;
    /** Only when locked: an opt-in type not named in `actions.enabled`, or named in `actions.disabled` (agents from 0.4.0 on). */
    lockedBy?: 'opt-in' | 'disabled';
    /** Off until the deployment names it in `actions.enabled` (agents from 0.4.0 on). */
    optIn?: boolean;
  }[];
  notifications: ToggleState;
}

export interface SettingsPatch {
  modules?: Record<string, boolean>;
  actions?: Partial<Record<ActionType, boolean>>;
  notifications?: boolean;
}
