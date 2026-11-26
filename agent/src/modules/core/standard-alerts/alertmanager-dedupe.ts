/**
 * One issue per problem, whoever reports it. A cluster with kube-prometheus-stack
 * fires the same upstream alerts Kubernanny checks itself (etcdMemberCommunicationSlow,
 * KubeNodeNotReady, ...); without this the app would show both. When an
 * Alertmanager alert is the same alert (same name, same identifying labels) as an
 * issue Kubernanny raised, the built-in issue stays, with its fuller text and a line
 * saying Alertmanager fires it too, and the alert leaves the Alertmanager module.
 */
import { evaluateAlerts, AmAlert } from '../../../checks/alertmanager.check';
import { podOwner } from '../../../checks/pods.check';
import { worst } from '../../../checks/types';
import { t } from '../../../i18n/text';
import { Inventory } from '../../../inventory/inventory';
import type { IssueView } from '../../../status/snapshot';
import type { ModuleView, RunData } from '../../types';
import { nodeOf } from '../node-clocks';

/** An issue Kubernanny raised and the upstream alert(s) it stands for. */
export interface AlertMatch {
  issueId: string;
  /** Upstream alert names, our own constants: only these are ever shown, never a name read from Alertmanager. */
  alerts: readonly string[];
  /** Labels an alert must carry with the same values; empty: the name alone identifies it. */
  labels: Record<string, string>;
}

// Kept per run (RunData is new every run) without widening RunData itself.
const firing = new WeakMap<RunData, AmAlert[]>();
const matches = new WeakMap<RunData, AlertMatch[]>();

/** The Alertmanager module hands over what fires (all of it, before grouping). */
export function recordFiringAlerts(data: RunData, alerts: AmAlert[]): void {
  firing.set(data, alerts);
}

/** A module that raised issues standing for upstream alerts says which. */
export function recordAlertMatches(data: RunData, found: AlertMatch[]): void {
  matches.set(data, [...(matches.get(data) ?? []), ...found]);
}

/**
 * Upstream alerts the older core checks already raise under their own ids:
 * alert name -> the issue id it is, from the alert's labels (undefined when it cannot tell).
 */
const COVERED_ELSEWHERE: Record<string, (labels: Record<string, string>, inv: Inventory) => string | undefined> = {
  KubeNodeNotReady: (l) => l.node && `nodes/${l.node}/not-ready`,
  KubeNodeUnreachable: (l) => l.node && `nodes/${l.node}/not-ready`,
  KubeNodePressure: (l) => l.node && l.condition && `nodes/${l.node}/${l.condition}`,
  KubePersistentVolumeFillingUp: (l) => l.namespace && l.persistentvolumeclaim && `volumes/${l.namespace}/${l.persistentvolumeclaim}/full`,
  NodeFilesystemSpaceFillingUp: (l, inv) => rootDisk(l, inv),
  NodeFilesystemAlmostOutOfSpace: (l, inv) => rootDisk(l, inv),
  NodeClockNotSynchronising: (l, inv) => clock(l, inv),
  NodeClockSkewDetected: (l, inv) => clock(l, inv),
  etcdMembersDown: () => 'etcd/members',
  etcdInsufficientMembers: () => 'etcd/members',
  TargetDown: (l) => l.job && `prometheus/down/${l.job}`,
  KubePodCrashLooping: (l, inv) => podIssue(l, inv),
  KubeContainerWaiting: (l, inv) => podIssue(l, inv),
  KubeDeploymentReplicasMismatch: (l) => l.namespace && l.deployment && `workloads/${l.namespace}/Deployment/${l.deployment}`,
  KubeStatefulSetReplicasMismatch: (l) => l.namespace && l.statefulset && `workloads/${l.namespace}/StatefulSet/${l.statefulset}`,
};

function rootDisk(l: Record<string, string>, inv: Inventory): string | undefined {
  const node = l.mountpoint === '/' ? nodeOf(inv, { metric: l, value: 0 }) : undefined;
  return node && `nodes/${node}/disk`;
}

function clock(l: Record<string, string>, inv: Inventory): string | undefined {
  const node = nodeOf(inv, { metric: l, value: 0 });
  return node && `node-clocks/${node}`;
}

function podIssue(l: Record<string, string>, inv: Inventory): string | undefined {
  const pod = inv.pods.find((p) => p.metadata.namespace === l.namespace && p.metadata.name === l.pod);
  if (!pod) {
    return undefined;
  }
  const owner = podOwner(pod);
  return `pods/${l.namespace}/${owner.kind}/${owner.name}`;
}

/** The issue an alert duplicates and the (trusted) alert name to mention, if any. */
function coveringIssue(alert: AmAlert, found: AlertMatch[], inv: Inventory, ids: ReadonlySet<string>): { issueId: string; alert: string } | undefined {
  const name = alert.labels.alertname;
  for (const m of found) {
    const known = m.alerts.find((a) => a === name);
    if (known && ids.has(m.issueId) && Object.entries(m.labels).every(([k, v]) => alert.labels[k] === v)) {
      return { issueId: m.issueId, alert: known };
    }
  }
  const elsewhere = Object.hasOwn(COVERED_ELSEWHERE, name ?? '') ? COVERED_ELSEWHERE[name!] : undefined;
  const id = elsewhere?.(alert.labels, inv) || undefined;
  // The key of the table, not the label: what is shown is always our own word.
  return id && ids.has(id) ? { issueId: id, alert: Object.keys(COVERED_ELSEWHERE).find((k) => k === name)! } : undefined;
}

/**
 * Merges Alertmanager duplicates into the issues that stand for them, in place:
 * `byId` loses the Alertmanager issues whose every alert is covered (or gets them
 * rebuilt from the rest), the covering issues gain the sentence, and the
 * Alertmanager module's sheet follows.
 */
export function dedupeAlerts(byId: Map<string, IssueView>, views: ModuleView[], data: RunData, inv: Inventory): void {
  const alerts = firing.get(data);
  if (!alerts?.length) {
    return;
  }
  const found = matches.get(data) ?? [];
  const ids = new Set(byId.keys());
  const mentioned = new Map<string, Set<string>>();
  const left: AmAlert[] = [];
  for (const alert of alerts) {
    const hit = coveringIssue(alert, found, inv, ids);
    if (hit) {
      mentioned.set(hit.issueId, (mentioned.get(hit.issueId) ?? new Set()).add(hit.alert));
    } else {
      left.push(alert);
    }
  }
  if (mentioned.size === 0) {
    return;
  }
  for (const [id, names] of mentioned) {
    const issue = byId.get(id)!;
    byId.set(id, { ...issue, cause: t('std.alsoAlertmanager', { cause: issue.cause, alerts: [...names].sort().join(', ') }) });
  }
  const rebuilt = new Map(evaluateAlerts(left).map((i) => [i.id, i]));
  const am = views.find((v) => v.id === 'alertmanager');
  for (const [id, issue] of [...byId]) {
    if (issue.module !== 'alertmanager' || !id.startsWith('alertmanager/')) {
      continue;
    }
    const kept = rebuilt.get(id);
    if (kept) {
      byId.set(id, { ...kept, module: issue.module, since: issue.since });
    } else if (!id.endsWith('/more')) {
      byId.delete(id);
    }
  }
  if (am) {
    am.issueIds = am.issueIds.filter((id) => byId.has(id));
    if (am.status !== 'error' && am.status !== 'skipped') {
      // As runComponent judges it: its issues, and its own pods.
      const pods = am.workloads.items;
      const readiness = pods.some((w) => w.desired > 0 && w.ready === 0) ? ('critical' as const) : pods.some((w) => w.ready < w.desired) ? ('warning' as const) : null;
      am.status = worst([...am.issueIds.map((id) => byId.get(id)!.severity), ...(readiness ? [readiness] : [])]);
    }
  }
}
