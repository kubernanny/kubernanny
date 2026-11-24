import { raw, rawOr, t } from '../i18n/text';
import { Issue, IssueAction, ObjectMeta, WorkloadKind } from './types';

interface AppResource {
  kind: string;
  name: string;
  namespace?: string;
  status?: string;
  health?: { status?: string; message?: string };
}

export interface ArgoApplication {
  metadata: ObjectMeta;
  spec?: { syncPolicy?: { automated?: unknown } };
  status?: {
    sync?: { status?: string; revision?: string };
    health?: { status?: string; message?: string };
    operationState?: { phase?: string; message?: string };
    resources?: AppResource[];
    conditions?: { type: string; message?: string }[];
  };
}

const RESTARTABLE = new Set<string>(['Deployment', 'StatefulSet', 'DaemonSet']);

export function evaluateArgoApps(apps: ArgoApplication[]): Issue[] {
  const issues: Issue[] = [];
  for (const app of apps) {
    const ns = app.metadata.namespace ?? 'argocd';
    const name = app.metadata.name;
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
      const restarts: IssueAction[] = broken
        .filter((r) => RESTARTABLE.has(r.kind) && r.health?.status === 'Degraded')
        .slice(0, 3)
        .map((r) => ({ type: 'restart', kind: r.kind as WorkloadKind, namespace: r.namespace ?? 'default', name: r.name }));
      const detail = broken
        .slice(0, 3)
        .map((r) => `${r.kind} ${r.name}${r.health?.message ? `: ${r.health.message}` : ''}`)
        .join('; ');
      issues.push({
        id: `argocd/${name}/health`,
        check: 'argocd',
        severity: 'critical',
        title: t('argocd.health.title', { app: name, health }),
        cause: rawOr(detail || app.status?.health?.message, t('argocd.health.cause', { health })),
        actions: [...restarts, ...syncActions],
      });
    }

    if (op && (op.phase === 'Failed' || op.phase === 'Error')) {
      issues.push({
        id: `argocd/${name}/operation`,
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
      const automated = app.spec?.syncPolicy?.automated !== undefined;
      issues.push({
        id: `argocd/${name}/sync`,
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
        id: `argocd/${name}/comparison`,
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
