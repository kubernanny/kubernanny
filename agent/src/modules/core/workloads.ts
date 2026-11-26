import { configMapQuestions, evaluateFinishedPods, evaluatePods, evaluateStuckTerminating } from '../../checks/pods.check';
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

/** The label job-rerun puts on the copy of a failed stand-alone Job, naming the original. */
export const RERUN_LABEL = 'kubernanny.io/rerun-of';

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
  // A failed stand-alone Job that was run again (job-rerun labels the copy): the copy speaks for it now.
  const rerun = new Set(inv.jobs.map((j) => j.metadata.labels?.[RERUN_LABEL] && `${j.metadata.namespace}/${j.metadata.labels[RERUN_LABEL]}`).filter(Boolean));
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
        actions: [...logsFor(ns, latest.metadata.name), { type: 'job-rerun', namespace: ns, from: 'CronJob', name: latest.metadata.ownerReferences!.find((o) => o.kind === 'CronJob')!.name }],
      });
    }
  }
  for (const job of standalone) {
    const failed = failedOf(job);
    const at = Date.parse(failed?.lastTransitionTime ?? job.status?.startTime ?? '');
    if (failed?.status === 'True' && Number.isFinite(at) && inv.at.getTime() - at < 86_400_000 && !rerun.has(`${job.metadata.namespace}/${job.metadata.name}`)) {
      const ns = job.metadata.namespace ?? 'default';
      // Only a Job nobody owns: one an operator (or Argo CD hook, Helm hook controller) created is that controller's to run again.
      const own = (job.metadata.ownerReferences ?? []).length === 0;
      issues.push({
        id: `jobs/${ns}/${job.metadata.name}`,
        check: 'pods',
        severity: 'warning',
        title: t('jobs.job.title', { job: `${ns}/${job.metadata.name}` }),
        cause: rawOr(failed.message ?? failed.reason, t('jobs.failed')),
        actions: [...logsFor(ns, job.metadata.name), ...(own ? [{ type: 'job-rerun' as const, namespace: ns, from: 'Job' as const, name: job.metadata.name }] : [])],
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
  override readonly actions = ['restart', 'logs', 'job-rerun', 'cleanup-pods', 'force-delete-terminating'] as const;

  protected async check(ctx: ModuleContext): Promise<ModuleResult> {
    const podIssues = evaluatePods(ctx.inv.pods, ctx.now, ctx.restartOn ? await changedConfigMaps(ctx) : undefined);
    // A workload whose crashing pods are already reported needs no second issue.
    const explained = new Set(podIssues.map((i) => i.id.replace(/^pods\//, '')));
    const issues = [
      ...podIssues,
      ...evaluateWorkloads(ctx.inv, explained),
      ...evaluateJobs(ctx.inv),
      ...evaluateStuckTerminating(ctx.inv.pods, ctx.inv.nodes, ctx.now),
      ...evaluateFinishedPods(ctx.inv.pods, ctx.inv.jobs, ctx.now),
    ];
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

/** At most this many ConfigMaps are read per run, so a namespace full of crash loops costs a bounded number of calls. */
const MAX_CONFIGMAP_READS = 20;

/**
 * For each crash-looping pod that reads ConfigMaps through env/envFrom: the
 * first of them changed after the container last started. Reads only their
 * metadata (`PartialObjectMetadata`), never `data`; the change time is the
 * newest managedFields entry. Without the permission (restart off, older
 * chart) or on any error the pod simply gets no such hint.
 */
async function changedConfigMaps(ctx: ModuleContext): Promise<Map<string, string>> {
  const questions = configMapQuestions(ctx.inv.pods, ctx.now);
  const out = new Map<string, string>();
  const cache = new Map<string, Promise<number | null>>();
  const changedAt = (ns: string, name: string): Promise<number | null> => {
    const key = `${ns}/${name}`;
    if (!cache.has(key)) {
      cache.set(
        key,
        cache.size >= MAX_CONFIGMAP_READS
          ? Promise.resolve(null)
          : ctx.kube
              .metadata<{ metadata?: { managedFields?: { time?: string }[]; creationTimestamp?: string } }>(`/api/v1/namespaces/${encodeURIComponent(ns)}/configmaps/${encodeURIComponent(name)}`)
              .then((m) => {
                const times = [...(m.metadata?.managedFields ?? []).map((f) => f.time), m.metadata?.creationTimestamp].map((x) => Date.parse(x ?? '')).filter(Number.isFinite);
                return times.length ? Math.max(...times) : null;
              })
              .catch(() => null),
      );
    }
    return cache.get(key)!;
  };
  for (const [pod, q] of questions) {
    const since = Date.parse(q.since);
    for (const name of q.configMaps) {
      const at = await changedAt(q.namespace, name);
      if (at !== null && at > since) {
        out.set(pod, name);
        break;
      }
    }
  }
  return out;
}
