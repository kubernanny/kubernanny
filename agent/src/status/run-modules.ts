import { CheckStatus, Issue, Severity, worst } from '../checks/types';
import { Detected } from '../discovery/discovery';
import { errorText, raw, t, Text } from '../i18n/text';
import { CoreCheck, Integration } from '../modules/module';
import { ModuleContext, ModuleResult, ModuleView } from '../modules/types';
import { componentDetails, componentStats } from '../modules/component-details';
import type { Inventory, InventoryKind } from '../inventory/inventory';
import { IssueView } from './snapshot';

/** What a recognised component's health rests on: its workloads, pods, services and routes. */
const COMPONENT_USES: readonly InventoryKind[] = ['pods', 'deployments', 'statefulsets', 'daemonsets', 'services', 'ingresses', 'httpRoutes', 'ingressRoutes'];

/** The error of a module whose inputs include a list that could not be read this run. */
function staleError(inv: Inventory, uses: readonly InventoryKind[]): Text | undefined {
  const stale = (inv.stale ?? []).filter((k) => uses.includes(k));
  return stale.length ? t('module.staleRead', { kinds: stale.join(', ') }) : undefined;
}

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

/**
 * A module that is not fine says why in its line: the worst open problem's
 * title, plus how many more there are. Its own summary stays when nothing is
 * wrong or it already names the problem (the same text as an issue title).
 */
export function summaryFor(summary: Text, issues: Pick<Issue, 'severity' | 'title'>[]): Text {
  const problems = issues.filter((i) => i.severity !== 'info').sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'critical' ? -1 : 1));
  if (problems.length === 0 || problems.some((p) => JSON.stringify(p.title) === JSON.stringify(summary))) {
    return problems.length > 1 && problems.some((p) => JSON.stringify(p.title) === JSON.stringify(summary)) ? t('module.summary.more', { first: summary, n: problems.length - 1 }) : summary;
  }
  return problems.length === 1 ? problems[0]!.title : t('module.summary.more', { first: problems[0]!.title, n: problems.length - 1 });
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
  const ran: ModuleResult & { error?: Text } = integration ? await safe(() => integration.run(ctx, d, allowed)) : { issues: [], stats: componentStats(ctx.inv, d), summary: workloadSummary(d.workloads, ready, total) };
  const result = ran.error ? ran : { ...ran, error: staleError(ctx.inv, COMPONENT_USES) };
  const status: CheckStatus = result.error
    ? 'error'
    : worst([...result.issues.map((i) => i.severity), ...([readinessStatus(d.workloads)].filter((s) => s !== 'ok') as Severity[])]);
  // The integration's own objects first, then what every component has: pods, resources, volumes.
  const details = [...(result.details ?? []), ...componentDetails(ctx.inv, ctx.data, d, ctx.now)];
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
      summary: result.error ? result.summary : summaryFor(result.summary, result.issues),
      // The version sits in the sheet's header (`version`), not among the key figures.
      stats: result.stats.filter((s) => s.label.$t !== 'stat.version'),
      ...(details.length ? { details } : {}),
      // An integration may list its own copies; otherwise every namespace the component runs in is one (Valkey per app).
      ...(result.instances?.length ? { instances: result.instances } : (d.instances?.length ?? 0) > 1 ? { instances: d.instances } : {}),
      links: d.links,
      workloads: { ready, total, items: d.workloads },
      issueIds: result.issues.map((i) => i.id),
      error: result.error,
      ...(result.accepted ? { accepted: result.accepted } : {}),
      ...(result.canAccept !== undefined ? { canAccept: result.canAccept } : {}),
      ...(result.rollbacks ? { rollbacks: result.rollbacks } : {}),
    },
  };
}

export async function runCoreCheck(ctx: ModuleContext, check: CoreCheck, allowed: ActionFilter): Promise<ModuleOutcome> {
  const ran = await safe(() => check.run(ctx, allowed));
  const result = ran.error ? ran : { ...ran, error: staleError(ctx.inv, check.uses) };
  return {
    issues: result.issues,
    view: {
      id: check.id,
      name: check.name,
      category: 'core',
      icon: check.icon,
      description: check.description,
      status: result.error ? 'error' : worst(result.issues.map((i) => i.severity)),
      summary: result.error ? result.summary : summaryFor(result.summary, result.issues),
      stats: result.stats,
      ...(result.details?.length ? { details: result.details } : {}),
      links: [],
      workloads: { ready: 0, total: 0, items: [] },
      issueIds: result.issues.map((i) => i.id),
      error: result.error,
      ...(result.accepted ? { accepted: result.accepted } : {}),
      ...(result.canAccept !== undefined ? { canAccept: result.canAccept } : {}),
    },
  };
}

/**
 * One issue per id across all modules (the first module wins), and every
 * workload issue and known vulnerability (built-in lookup per component,
 * Trivy Operator per workload) also listed on the component it is about, so
 * the Argo CD sheet shows a crashing argocd-repo-server.
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
    const ids = [
      ...view.workloads.items.flatMap((w) => ['pods', 'workloads', 'trivy'].map((prefix) => `${prefix}/${w.namespace}/${w.kind}/${w.name}`)),
      `vulnerabilities/${view.id}`,
      `image-updates/${view.id}`,
    ];
    for (const id of ids) {
      if (byId.has(id) && !view.issueIds.includes(id)) {
        view.issueIds.push(id);
        const severity = byId.get(id)!.severity;
        if (severity !== 'info' && (view.status === 'ok' || (view.status === 'warning' && severity === 'critical'))) {
          view.status = severity;
        }
      }
    }
    // A crashing workload or a known vulnerability makes the component's line say so too.
    if (view.status === 'warning' || view.status === 'critical') {
      view.summary = summaryFor(view.summary, view.issueIds.map((id) => byId.get(id)).filter((i): i is IssueView => i !== undefined && !i.silencedUntil));
    }
  }
  return byId;
}
