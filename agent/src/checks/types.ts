import { Text, t } from '../i18n/text';

export type Severity = 'warning' | 'critical';

/**
 * `info`: worth seeing, not a problem. Shown under "Hinweise", but never
 * colours the light, never costs score and never notifies.
 */
export type IssueSeverity = Severity | 'info';

/** What a check reports as a whole. `skipped`: the component is not installed in this cluster. */
export type CheckStatus = 'ok' | Severity | 'skipped' | 'error';

export type CheckId =
  | 'nodes'
  | 'etcd'
  | 'pods'
  | 'longhorn'
  | 'certificates'
  | 'argocd'
  | 'cnpg'
  | 'alertmanager';

export type WorkloadKind = 'Deployment' | 'StatefulSet' | 'DaemonSet';

/**
 * An action an issue offers. The app never sends one of these back: it names
 * the issue and the action type, and the agent runs the action stored on the
 * issue it currently sees. So the app can only ever do what an open issue offers.
 */
export type IssueAction =
  | { type: 'argocd-sync'; namespace: string; app: string }
  | { type: 'argocd-refresh'; namespace: string; app: string }
  /**
   * `secondary`: offered after the logs, with a hint that it only helps once the
   * cause is gone (a crash loop). `changed`: a ConfigMap the pod reads through
   * env/envFrom changed after its last start, so the restart is the fix.
   */
  | { type: 'restart'; kind: WorkloadKind; namespace: string; name: string; secondary?: boolean; changed?: { kind: 'ConfigMap'; name: string } }
  | { type: 'logs'; namespace: string; pod: string; container?: string; previous?: boolean }
  | { type: 'cnpg-backup'; namespace: string; cluster: string }
  | { type: 'uncordon'; node: string }
  /** `from: 'CronJob'`: a new Job from the CronJob's jobTemplate. `from: 'Job'`: a copy of a failed stand-alone Job. */
  | { type: 'job-rerun'; namespace: string; from: 'CronJob' | 'Job'; name: string }
  | { type: 'reconcile-now'; kind: ReconcileKind; namespace: string; name: string }
  | { type: 'cleanup-pods'; namespace: string; pods: string[] }
  | { type: 'force-delete-terminating'; namespace: string; pod: string; node: string; statefulSet?: string }
  | { type: 'longhorn-backup'; namespace: string; volume: string; label: string }
  | { type: 'velero-backup'; namespace: string; schedule: string }
  | { type: 'argocd-terminate-op'; namespace: string; app: string }
  /** `from` and `to` are quantities ("8Gi" -> "10Gi"); `template`: the StatefulSet whose volumeClaimTemplates made the claim. */
  | { type: 'pvc-expand'; namespace: string; name: string; from: string; to: string; template?: string };

/** The objects `reconcile-now` can ask their controller to reconcile at once. */
export type ReconcileKind = 'Kustomization' | 'HelmRelease' | 'ExternalSecret' | 'InfisicalStaticSecret' | 'Certificate';

export type IssueActionType = IssueAction['type'];

/**
 * Every action type with a switch: the ones issues offer, plus actions that
 * stand on their own (`argocd-rollback`, offered on the Argo CD sheet for any
 * manual-sync app, whether or not something is wrong with it).
 */
export type ActionType = IssueActionType | 'argocd-rollback';

/**
 * Action types that stay locked until the deployment opts in (Helm
 * `actions.enabled`, env `ENABLED_ACTIONS`). The app cannot switch them on.
 * Each needs a permission whose misuse by a compromised pod reaches further
 * than the action itself (create Jobs, force-delete pods, end an Argo CD
 * operation, grow volumes), see docs/SECURITY.md.
 */
export const OPT_IN_ACTIONS: readonly ActionType[] = ['argocd-rollback', 'job-rerun', 'force-delete-terminating', 'argocd-terminate-op', 'pvc-expand'];

export interface Issue {
  /** Stable across runs, so the app and the notifier can follow one problem. */
  id: string;
  /** The area it belongs to (a check id or a module id). */
  check: CheckId | string;
  severity: IssueSeverity;
  /** What is broken, short: "Node rke2-node-4 NotReady". */
  title: Text;
  /** Why, in one or two sentences. */
  cause: Text;
  actions: IssueAction[];
  /** OSV advisory ids (vulnerabilities module); the app links each to osv.dev. */
  advisories?: string[];
}

export interface CheckResult {
  id: CheckId;
  label: Text;
  status: CheckStatus;
  issues: Issue[];
  /** Set when status is `error`: the check itself failed (API unreachable, RBAC). */
  error?: Text;
}

export interface CheckContext {
  now: Date;
}

export interface Check {
  id: CheckId;
  label: Text;
  /** Resolves to null when the component is not installed (CRD or service missing). */
  run(ctx: CheckContext): Promise<Issue[] | null>;
}

/** The worst severity; `info` counts as fine. */
export function worst(severities: Iterable<IssueSeverity>): 'ok' | Severity {
  let result: 'ok' | Severity = 'ok';
  for (const s of severities) {
    if (s === 'critical') {
      return 'critical';
    }
    if (s === 'warning') {
      result = 'warning';
    }
  }
  return result;
}

export interface Condition {
  type: string;
  status: string;
  reason?: string;
  message?: string;
  lastTransitionTime?: string;
}

export function condition(conditions: Condition[] | undefined, type: string): Condition | undefined {
  return conditions?.find((c) => c.type === type);
}

export interface ObjectMeta {
  name: string;
  namespace?: string;
  labels?: Record<string, string>;
  annotations?: Record<string, string>;
  creationTimestamp?: string;
  ownerReferences?: { kind: string; name: string; apiVersion?: string; uid?: string }[];
}

/** A duration as people say it: minutes, then hours, from two days on days. */
export function ageText(ms: number): Text {
  const hours = ms / 3_600_000;
  if (hours < 1) {
    return t('age.minutes', { n: Math.max(1, Math.round(ms / 60_000)) });
  }
  if (hours < 48) {
    return t('age.hours', { n: Math.round(hours) });
  }
  return t('age.days', { n: Math.round(hours / 24) });
}
