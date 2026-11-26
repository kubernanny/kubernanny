import { allWorkloads, readiness } from '../discovery/discovery';
import { raw, rawOr, t } from '../i18n/text';
import type { Inventory } from '../inventory/inventory';
import { lastSyncAt, PENDING_HINT_DAYS } from './argocd-pending';
import type { ArgoHistoryEntry, ArgoSource } from './argocd-rollback';
import { syncOffer } from './argocd-sync-offer';
import { ageText, Issue, IssueAction, ObjectMeta, WorkloadKind } from './types';

interface AppResource {
  kind: string;
  name: string;
  namespace?: string;
  status?: string;
  health?: { status?: string; message?: string };
  /** In the cluster, no longer in Git: a sync with pruning removes it. */
  requiresPruning?: boolean;
}

/**
 * Whether Argo CD syncs the app by itself. `automated: {}` turns it on;
 * Argo CD 3 also knows `automated: { enabled: false }`, which keeps the
 * settings but syncs manually (IsAutomatedSyncEnabled in Argo CD's types).
 */
export function isAutomated(app: Pick<ArgoApplication, 'spec'>): boolean {
  const a = app.spec?.syncPolicy?.automated;
  return a !== undefined && a !== null && (a as { enabled?: boolean }).enabled !== false;
}

export interface ArgoApplication {
  metadata: ObjectMeta;
  spec?: {
    syncPolicy?: { automated?: unknown; syncOptions?: unknown };
    destination?: { namespace?: string };
    source?: ArgoSource;
    sources?: ArgoSource[];
  };
  /** Set while an operation (a sync) is requested and not yet picked up. */
  operation?: unknown;
  status?: {
    /** The deployments Argo CD remembers (`revisionHistoryLimit`, 10 by default), oldest first. */
    history?: ArgoHistoryEntry[];
    sync?: { status?: string; revision?: string };
    /** `lastTransitionTime` from Argo CD 3 on. */
    health?: { status?: string; message?: string; lastTransitionTime?: string };
    operationState?: {
      phase?: string;
      message?: string;
      startedAt?: string;
      finishedAt?: string;
      syncResult?: { revision?: string };
      operation?: { sync?: { syncOptions?: unknown } };
    };
    resources?: AppResource[];
    conditions?: { type: string; message?: string }[];
  };
}

/** How long a running operation may take before ending it is offered. */
const OPERATION_STUCK_MS = 30 * 60_000;

/** How long an app may be Degraded right after a sync before it counts: the new pods are starting. */
export const ARGO_ROLLOUT_GRACE_MS = 3 * 60_000;
/** A sync running, or finished at most this long ago, is a rollout that may still settle. */
const ROLLOUT_WINDOW_MS = 10 * 60_000;

/**
 * A rollout settling: the app turned Degraded less than ARGO_ROLLOUT_GRACE_MS
 * ago, during or shortly after a sync (a readiness probe failing for a few
 * seconds while the new pods start). Measured from the health's last change
 * (Argo CD 3), else from the sync's start; past the grace it is reported as
 * usual, so a rollout that really breaks the app shows after three minutes.
 */
export function settlingAfterSync(app: ArgoApplication, now: number): boolean {
  if (app.status?.health?.status !== 'Degraded') {
    return false;
  }
  const op = app.status.operationState;
  const synced = op?.phase === 'Running' ? now : Date.parse(op?.finishedAt ?? '');
  if (!Number.isFinite(synced) || now - synced > ROLLOUT_WINDOW_MS) {
    return false;
  }
  const changed = Date.parse(app.status.health.lastTransitionTime ?? '');
  const from = Number.isFinite(changed) ? changed : Date.parse(op?.startedAt ?? '');
  return Number.isFinite(from) && now - from < ARGO_ROLLOUT_GRACE_MS;
}

const RESTARTABLE = new Set<string>(['Deployment', 'StatefulSet', 'DaemonSet']);

/**
 * Restarts for the resources an Application reports as degraded, but only
 * for a workload the agent's own inventory shows not ready, in the
 * Application's destination namespace. `status.resources` is written by
 * whoever can create or edit an Application, so on its own it could point a
 * restart at any workload in the cluster (kube-system/cilium); the inventory
 * and the destination are what the agent believes.
 */
function restartTargets(app: ArgoApplication, broken: AppResource[], inv: Inventory | undefined): IssueAction[] {
  const destination = app.spec?.destination?.namespace;
  if (!inv || !destination) {
    return [];
  }
  const notReady = new Set(
    allWorkloads(inv)
      .filter(({ kind, w }) => {
        const r = readiness(kind, w);
        return r.ready < r.desired;
      })
      .map(({ kind, w }) => `${kind}/${w.metadata.namespace ?? 'default'}/${w.metadata.name}`),
  );
  const seen = new Set<string>();
  const out: IssueAction[] = [];
  for (const r of broken) {
    const target: string = r.namespace ?? destination;
    const key = `${r.kind}/${target}/${r.name}`;
    if (
      !RESTARTABLE.has(r.kind) ||
      r.health?.status !== 'Degraded' ||
      target !== destination ||
      !notReady.has(key) ||
      seen.has(key)
    ) {
      continue;
    }
    seen.add(key);
    out.push({ type: 'restart', kind: r.kind as WorkloadKind, namespace: target, name: r.name });
  }
  return out.slice(0, 3);
}

/** `inv`: the agent's inventory, the only source of restart targets; without it no restart is offered. */
export function evaluateArgoApps(apps: ArgoApplication[], inv?: Inventory, now: Date = new Date()): Issue[] {
  const issues: Issue[] = [];
  for (const app of apps) {
    const ns = app.metadata.namespace ?? 'argocd';
    const name = app.metadata.name;
    // The namespace too: Applications in any namespace (Argo CD 2.5+) can share a name.
    const id = `argocd/${ns}/${name}`;
    const health = app.status?.health?.status;
    const sync = app.status?.sync?.status;
    const op = app.status?.operationState;
    const syncing = op?.phase === 'Running';

    const syncActions: IssueAction[] = syncing
      ? []
      : [
          // The switches are applied by the module run (keepActions), like every other action's.
          { type: 'argocd-sync', namespace: ns, app: name, offer: syncOffer(app, { prune: false, replace: false }) },
          { type: 'argocd-refresh', namespace: ns, app: name },
        ];

    if ((health === 'Degraded' || health === 'Missing') && !settlingAfterSync(app, now.getTime())) {
      const broken = (app.status?.resources ?? []).filter(
        (r) => r.health?.status === 'Degraded' || r.health?.status === 'Missing',
      );
      const restarts = restartTargets(app, broken, inv);
      const detail = broken
        .slice(0, 3)
        .map((r) => `${r.kind} ${r.name}${r.health?.message ? `: ${r.health.message}` : ''}`)
        .join('; ');
      issues.push({
        id: `${id}/health`,
        check: 'argocd',
        severity: 'critical',
        title: t('argocd.health.title', { app: name, health }),
        cause: rawOr(detail || app.status?.health?.message, t('argocd.health.cause', { health })),
        actions: [...restarts, ...syncActions],
      });
    }

    const started = Date.parse(op?.startedAt ?? '');
    if (syncing && Number.isFinite(started) && now.getTime() - started > OPERATION_STUCK_MS) {
      // A sync that hangs (a hook Job that never ends, a resource that never gets healthy) blocks every later sync.
      issues.push({
        id: `${id}/operation-stuck`,
        check: 'argocd',
        severity: 'warning',
        title: t('argocd.opStuck.title', { app: name, age: ageText(now.getTime() - started) }),
        cause: rawOr(op?.message, t('argocd.opStuck.cause')),
        actions: [{ type: 'argocd-terminate-op', namespace: ns, app: name }],
      });
    }

    if (op && (op.phase === 'Failed' || op.phase === 'Error')) {
      issues.push({
        id: `${id}/operation`,
        check: 'argocd',
        severity: 'critical',
        title: t('argocd.syncFailed.title', { app: name }),
        cause: rawOr(op.message, t('argocd.syncFailed.cause')),
        actions: syncActions,
      });
    } else if (sync === 'OutOfSync') {
      // Automated: Argo should have fixed it within minutes, so a sync is
      // stuck or something edits the cluster behind Git's back. Manual: the
      // normal state between a commit and the sync someone chooses to run,
      // listed as "ready to sync" (argocd-pending.ts), not as an issue; only
      // after PENDING_HINT_DAYS without any sync a hint says it waits long.
      const automated = isAutomated(app);
      const last = Date.parse(lastSyncAt(app) ?? '');
      const waited = Number.isFinite(last) ? now.getTime() - last : null;
      if (automated) {
        issues.push({
          id: `${id}/sync`,
          check: 'argocd',
          severity: 'warning',
          title: t('argocd.drift.title', { app: name }),
          cause: t('argocd.drift.cause'),
          actions: syncActions,
        });
      } else if (
        health !== 'Degraded' &&
        health !== 'Missing' &&
        waited !== null &&
        waited > PENDING_HINT_DAYS * 86_400_000
      ) {
        issues.push({
          id: `${id}/sync`,
          check: 'argocd',
          severity: 'info',
          title: t('argocd.pending.title', { app: name }),
          cause: t('argocd.pending.longCause', { age: ageText(waited) }),
          actions: syncActions,
        });
      }
    }

    const comparisonError = app.status?.conditions?.find((c) => c.type === 'ComparisonError');
    if (comparisonError) {
      issues.push({
        id: `${id}/comparison`,
        check: 'argocd',
        severity: 'warning',
        title: t('argocd.comparison.title', { app: name }),
        cause: raw(comparisonError.message ?? 'ComparisonError'),
        actions: syncing ? [] : [{ type: 'argocd-refresh', namespace: ns, app: name }],
      });
    }
  }
  return issues;
}
