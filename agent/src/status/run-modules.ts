import { CheckStatus, Issue, Severity, worst } from '../checks/types';
import { Detected } from '../discovery/discovery';
import { errorText, raw, t, Text } from '../i18n/text';
import { CoreCheck, Integration } from '../modules/module';
import { ModuleContext, ModuleResult, ModuleView } from '../modules/types';
import { IssueView } from './snapshot';

/** What one module contributed to a run: its sheet in the app and its issues. */
export interface ModuleOutcome {
  view: ModuleView;
  issues: Issue[];
}

type ActionFilter = Parameters<CoreCheck['run']>[1];

/** A module that throws is reported as "not checkable" with its error; the run goes on. */
async function safe(fn: () => Promise<ModuleResult>): Promise<ModuleResult & { error?: Text }> {
  try {
    return await fn();
  } catch (err) {
    return { issues: [], stats: [], summary: t('module.checkFailed'), error: errorText(err) };
  }
}

/** The line under a component without a deep check: how many of its pods are ready. */
function workloadSummary(workloads: { kind: string }[], ready: number, total: number): Text {
  if (workloads.every((w) => w.kind === 'CronJob')) {
    return t('workloadHealth.scheduled');
  }
  if (total === 0) {
    return t('workloadHealth.none');
  }
  return ready === total ? t('workloadHealth.ready', { n: ready }) : t('workloadHealth.partial', { ready, total });
}

function readinessStatus(items: { ready: number; desired: number }[]): CheckStatus {
  if (items.some((w) => w.desired > 0 && w.ready === 0)) {
    return 'critical';
  }
  return items.some((w) => w.ready < w.desired) ? 'warning' : 'ok';
}

/** A recognised component: its integration if it has one, else the health of its workloads. */
export async function runComponent(ctx: ModuleContext, d: Detected, integration: Integration | undefined, allowed: ActionFilter): Promise<ModuleOutcome> {
  const total = d.workloads.reduce((s, w) => s + w.desired, 0);
  const ready = d.workloads.reduce((s, w) => s + Math.min(w.ready, w.desired), 0);
  const result = integration ? await safe(() => integration.run(ctx, d, allowed)) : { issues: [], stats: [], summary: workloadSummary(d.workloads, ready, total) };
  const status: CheckStatus = result.error
    ? 'error'
    : worst([...result.issues.map((i) => i.severity), ...([readinessStatus(d.workloads)].filter((s) => s !== 'ok') as Severity[])]);
  return {
    issues: result.issues,
    view: {
      id: d.entry.id,
      name: raw(d.entry.name),
      category: d.entry.category,
      icon: d.entry.icon,
      description: d.entry.description,
      namespace: d.namespace,
      version: d.version,
      status,
      summary: result.summary,
      stats: [...(d.version ? [{ label: t('stat.version'), value: d.version }] : []), ...result.stats.filter((s) => s.label.$t !== 'stat.version')],
      links: d.links,
      workloads: { ready, total, items: d.workloads },
      issueIds: result.issues.map((i) => i.id),
      error: result.error,
    },
  };
}

export async function runCoreCheck(ctx: ModuleContext, check: CoreCheck, allowed: ActionFilter): Promise<ModuleOutcome> {
  const result = await safe(() => check.run(ctx, allowed));
  return {
    issues: result.issues,
    view: {
      id: check.id,
      name: check.name,
      category: 'core',
      icon: check.icon,
      description: check.description,
      status: result.error ? 'error' : worst(result.issues.map((i) => i.severity)),
      summary: result.summary,
      stats: result.stats,
      links: [],
      workloads: { ready: 0, total: 0, items: [] },
      issueIds: result.issues.map((i) => i.id),
      error: result.error,
    },
  };
}

/**
 * One issue per id across all modules (the first module wins), and every
 * workload issue and known vulnerability also listed on the component it is
 * about, so the Argo CD sheet shows a crashing argocd-repo-server.
 */
export function mergeIssues(core: ModuleOutcome[], components: ModuleOutcome[]): Map<string, IssueView> {
  const byId = new Map<string, IssueView>();
  for (const { view, issues } of [...core, ...components]) {
    for (const issue of issues) {
      if (!byId.has(issue.id)) {
        byId.set(issue.id, { ...issue, module: view.id, since: '' });
      }
    }
  }
  for (const { view } of components) {
    const ids = [...view.workloads.items.flatMap((w) => ['pods', 'workloads'].map((prefix) => `${prefix}/${w.namespace}/${w.kind}/${w.name}`)), `vulnerabilities/${view.id}`];
    for (const id of ids) {
      if (byId.has(id) && !view.issueIds.includes(id)) {
        view.issueIds.push(id);
        const severity = byId.get(id)!.severity;
        if (severity !== 'info' && (view.status === 'ok' || (view.status === 'warning' && severity === 'critical'))) {
          view.status = severity;
        }
      }
    }
  }
  return byId;
}
