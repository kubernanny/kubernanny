import { allWorkloads, readiness } from '../discovery/discovery';
import { raw, rawOr, t } from '../i18n/text';
import type { Inventory } from '../inventory/inventory';
import type { ArgoHistoryEntry, ArgoSource } from './argocd-rollback';
import { Issue, IssueAction, ObjectMeta, WorkloadKind } from './types';

interface AppResource {
  kind: string;
  name: string;
  namespace?: string;
  status?: string;
  health?: { status?: string; message?: string };
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
  spec?: { syncPolicy?: { automated?: unknown }; destination?: { namespace?: string }; source?: ArgoSource; sources?: ArgoSource[] };
  /** Set while an operation (a sync) is requested and not yet picked up. */
  operation?: unknown;
  status?: {
    /** The deployments Argo CD remembers (`revisionHistoryLimit`, 10 by default), oldest first. */
    history?: ArgoHistoryEntry[];
    sync?: { status?: string; revision?: string };
    health?: { status?: string; message?: string };
    operationState?: { phase?: string; message?: string };
    resources?: AppResource[];
    conditions?: { type: string; message?: string }[];
  };
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
export function restartTargets(app: ArgoApplication, broken: AppResource[], inv: Inventory | undefined): IssueAction[] {
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
    if (!RESTARTABLE.has(r.kind) || r.health?.status !== 'Degraded' || target !== destination || !notReady.has(key) || seen.has(key)) {
      continue;
    }
    seen.add(key);
    out.push({ type: 'restart', kind: r.kind as WorkloadKind, namespace: target, name: r.name });
  }
  return out.slice(0, 3);
}

/** `inv`: the agent's inventory, the only source of restart targets; without it no restart is offered. */
export function evaluateArgoApps(apps: ArgoApplication[], inv?: Inventory): Issue[] {
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
          { type: 'argocd-sync', namespace: ns, app: name },
          { type: 'argocd-refresh', namespace: ns, app: name },
        ];

    if (health === 'Degraded' || health === 'Missing') {
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
      // Manual sync: OutOfSync is the normal state between a commit and the
      // sync someone chooses to run. Automated: Argo should have fixed it
      // within minutes, so a sync is stuck or something edits the cluster
      // behind Git's back.
      const automated = isAutomated(app);
      issues.push({
        id: `${id}/sync`,
        check: 'argocd',
        severity: automated ? 'warning' : 'info',
        title: automated ? t('argocd.drift.title', { app: name }) : t('argocd.pending.title', { app: name }),
        cause: automated ? t('argocd.drift.cause') : t('argocd.pending.cause'),
        actions: syncActions,
      });
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
