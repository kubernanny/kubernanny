import { evaluatePods } from '../../checks/pods.check';
import { condition, Issue, IssueAction } from '../../checks/types';
import { allWorkloads, readiness } from '../../discovery/discovery';
import { rawOr, t } from '../../i18n/text';
import { Inventory } from '../../inventory/inventory';
import { CoreCheck } from '../module';
import { ModuleContext, ModuleResult } from '../types';

/** Deployments and StatefulSets without pods that would explain it (crashing pods are reported per pod). */
export function evaluateWorkloads(inv: Inventory, explained: Set<string>): Issue[] {
  const issues: Issue[] = [];
  for (const { kind, w } of allWorkloads(inv)) {
    const ns = w.metadata.namespace ?? 'default';
    const key = `${ns}/${kind}/${w.metadata.name}`;
    if (explained.has(key)) {
      continue;
    }
    const { ready, desired } = readiness(kind, w);
    const progressing = condition(w.status?.conditions, 'Progressing');
    const stuck = progressing?.reason === 'ProgressDeadlineExceeded';
    if (desired === 0 || (ready >= desired && !stuck)) {
      continue;
    }
    const created = Date.parse(w.metadata.creationTimestamp ?? '');
    // A rollout in its first minutes is not a problem yet.
    const young = Number.isFinite(created) && inv.at.getTime() - created < 5 * 60_000;
    if (young && !stuck) {
      continue;
    }
    const restart: IssueAction = { type: 'restart', kind, namespace: ns, name: w.metadata.name };
    issues.push({
      id: `workloads/${key}`,
      check: 'pods',
      severity: ready === 0 ? 'critical' : 'warning',
      title: t('workloads.title', { workload: `${ns}/${w.metadata.name}`, ready, desired }),
      cause: stuck
        ? rawOr(progressing?.message, t('workloads.stuck'))
        : ready === 0
          ? t(kind === 'DaemonSet' ? 'workloads.noneReady.daemonSet' : 'workloads.noneReady.replica')
          : t('workloads.someNotReady', { missing: desired - ready, desired }),
      actions: [restart],
    });
  }
  return issues;
}

/** The newest run of every CronJob, and stand-alone Jobs of the last day. */
export function evaluateJobs(inv: Inventory): Issue[] {
  const issues: Issue[] = [];
  const byCron = new Map<string, typeof inv.jobs>();
  const standalone: typeof inv.jobs = [];
  for (const job of inv.jobs) {
    const owner = job.metadata.ownerReferences?.find((o) => o.kind === 'CronJob');
    if (owner) {
      const key = `${job.metadata.namespace}/${owner.name}`;
      byCron.set(key, [...(byCron.get(key) ?? []), job]);
    } else {
      standalone.push(job);
    }
  }
  const failedOf = (job: (typeof inv.jobs)[number]) => condition(job.status?.conditions, 'Failed');
  const logsFor = (ns: string, jobName: string): IssueAction[] => {
    const pod = inv.pods
      .filter((p) => p.metadata.namespace === ns && p.metadata.ownerReferences?.some((o) => o.kind === 'Job' && o.name === jobName))
      .sort((a, b) => (b.metadata.creationTimestamp ?? '').localeCompare(a.metadata.creationTimestamp ?? ''))[0];
    return pod ? [{ type: 'logs', namespace: ns, pod: pod.metadata.name }] : [];
  };

  for (const [key, jobs] of byCron) {
    const latest = jobs
      .filter((j) => j.status?.completionTime || failedOf(j)?.status === 'True')
      .sort((a, b) => (b.metadata.creationTimestamp ?? '').localeCompare(a.metadata.creationTimestamp ?? ''))[0];
    const failed = latest && failedOf(latest);
    if (latest && failed?.status === 'True') {
      const ns = latest.metadata.namespace ?? 'default';
      issues.push({
        id: `jobs/${key}`,
        check: 'pods',
        severity: 'warning',
        title: t('jobs.cron.title', { cron: key }),
        cause: rawOr(failed.message ?? failed.reason, t('jobs.failed')),
        actions: logsFor(ns, latest.metadata.name),
      });
    }
  }
  for (const job of standalone) {
    const failed = failedOf(job);
    const at = Date.parse(failed?.lastTransitionTime ?? job.status?.startTime ?? '');
    if (failed?.status === 'True' && Number.isFinite(at) && inv.at.getTime() - at < 86_400_000) {
      const ns = job.metadata.namespace ?? 'default';
      issues.push({
        id: `jobs/${ns}/${job.metadata.name}`,
        check: 'pods',
        severity: 'warning',
        title: t('jobs.job.title', { job: `${ns}/${job.metadata.name}` }),
        cause: rawOr(failed.message ?? failed.reason, t('jobs.failed')),
        actions: logsFor(ns, job.metadata.name),
      });
    }
  }
  return issues;
}

export class WorkloadsCheck extends CoreCheck {
  readonly id = 'pods';
  override readonly uses = ['pods', 'deployments', 'statefulsets', 'daemonsets', 'jobs', 'cronjobs'] as const;
  readonly name = t('module.pods.name');
  readonly icon = 'cube-outline';
  readonly description = t('module.pods.description');
  readonly reads = [];
  override readonly actions = ['restart', 'logs'] as const;

  protected async check(ctx: ModuleContext): Promise<ModuleResult> {
    const podIssues = evaluatePods(ctx.inv.pods, ctx.now);
    // A workload whose crashing pods are already reported needs no second issue.
    const explained = new Set(podIssues.map((i) => i.id.replace(/^pods\//, '')));
    const issues = [...podIssues, ...evaluateWorkloads(ctx.inv, explained), ...evaluateJobs(ctx.inv)];
    const running = ctx.inv.pods.filter((p) => p.status?.phase === 'Running').length;
    const restarts = ctx.inv.pods.reduce((sum, p) => sum + (p.status?.containerStatuses ?? []).reduce((s, c) => s + c.restartCount, 0), 0);
    const all = allWorkloads(ctx.inv);
    return {
      issues,
      stats: [
        { label: t('pods.stat.running'), value: `${running}/${ctx.inv.pods.filter((p) => p.status?.phase !== 'Succeeded').length}` },
        { label: t('stat.workloads'), value: String(all.length) },
        { label: t('pods.stat.cronJobs'), value: String(ctx.inv.cronjobs.length) },
        { label: t('pods.stat.restarts'), value: String(restarts) },
      ],
      summary: issues.length === 0 ? t('pods.summary.ok', { n: all.length }) : t('pods.summary.problems', { n: issues.length }),
    };
  }
}
