/**
 * The upstream alerts Kubernanny can judge from the objects it already reads,
 * without Prometheus: they run in every cluster.
 */
import { Issue } from '../../../checks/types';
import { t } from '../../../i18n/text';
import { Inventory, parseQuantity } from '../../../inventory/inventory';
import type { AlertMatch } from './alertmanager-dedupe';

const ID = 'standard-alerts';

/** Requests against what the cluster can still offer after losing its largest node. */
export interface Overcommit {
  resource: 'cpu' | 'memory';
  /** Sum of the requests of all pods that are Pending or Running (cores, bytes). */
  requested: number;
  /** Sum of the nodes' allocatable. */
  allocatable: number;
  /** The largest single node's allocatable. */
  largest: number;
  nodes: number;
}

/** Pods that hold their requests: everything not finished (kube-state-metrics' Pending|Running, as the mixin's recording rule counts). */
const holdsResources = (phase: string | undefined) => phase !== 'Succeeded' && phase !== 'Failed';

export function overcommit(inv: Inventory): Overcommit[] {
  return (['cpu', 'memory'] as const).map((resource) => {
    const capacities = inv.nodes.map((n) => parseQuantity(n.status?.allocatable?.[resource]));
    let requested = 0;
    for (const p of inv.pods) {
      if (!holdsResources(p.status?.phase)) {
        continue;
      }
      for (const c of p.spec?.containers ?? []) {
        requested += parseQuantity(c.resources?.requests?.[resource]);
      }
    }
    return {
      resource,
      requested,
      allocatable: capacities.reduce((a, b) => a + b, 0),
      largest: Math.max(0, ...capacities),
      nodes: capacities.length,
    };
  });
}

/** What remains when the largest node is gone. */
export const spare = (o: Overcommit) => o.allocatable - o.largest;

/**
 * KubeCPUOvercommit / KubeMemoryOvercommit (kubernetes-mixin, warning, for 10m):
 *   sum(requests) - (sum(allocatable) - max(allocatable)) > 0 and (sum(allocatable) - max(allocatable)) > 0
 * The cluster cannot lose its largest node: the pods running there would not fit on the others.
 * Requests only change with deployments, so the instantaneous value stands in for the `for`.
 */
export function evaluateOvercommit(values: Overcommit[]): { issues: Issue[]; matches: AlertMatch[] } {
  const issues: Issue[] = [];
  const matches: AlertMatch[] = [];
  for (const o of values) {
    const rest = spare(o);
    if (rest <= 0 || o.requested <= rest) {
      continue;
    }
    const id = `${ID}/overcommit/${o.resource}`;
    const pct = Math.round((o.requested / rest) * 100);
    issues.push({
      id,
      check: ID,
      severity: 'warning',
      title: t(o.resource === 'cpu' ? 'std.overcommit.cpuTitle' : 'std.overcommit.memoryTitle', { pct }),
      cause: t('std.overcommit.cause', { pct }),
      actions: [],
    });
    matches.push({
      issueId: id,
      alerts: [o.resource === 'cpu' ? 'KubeCPUOvercommit' : 'KubeMemoryOvercommit'],
      labels: {},
    });
  }
  return { issues, matches };
}

/** KubeletTooManyPods (kubernetes-mixin, info): running pods / the node's pod capacity > 95 %. A hint, as upstream. */
export function evaluatePodCapacity(inv: Inventory): { issues: Issue[]; matches: AlertMatch[] } {
  const issues: Issue[] = [];
  const matches: AlertMatch[] = [];
  for (const n of inv.nodes) {
    const capacity = parseQuantity(n.status?.capacity?.pods);
    if (capacity <= 1) {
      continue;
    }
    const running = inv.pods.filter(
      (p) => p.spec?.nodeName === n.metadata.name && holdsResources(p.status?.phase),
    ).length;
    if (running / capacity > 0.95) {
      const id = `${ID}/too-many-pods/${n.metadata.name}`;
      issues.push({
        id,
        check: ID,
        severity: 'info',
        title: t('std.tooManyPods.title', { node: n.metadata.name, n: running, max: capacity }),
        cause: t('std.tooManyPods.cause'),
        actions: [],
      });
      matches.push({ issueId: id, alerts: ['KubeletTooManyPods'], labels: { node: n.metadata.name } });
    }
  }
  return { issues, matches };
}

/** "v1.36.6+rke2r1" -> "1.36". */
const minor = (v: string | undefined) => /^v?(\d+\.\d+)/.exec(v ?? '')?.[1];

/**
 * KubeVersionMismatch (kubernetes-mixin, warning for 15m): more than one minor version among the components.
 * A hint here: every rolling upgrade passes through it, and it only matters when it stays.
 */
export function evaluateVersions(inv: Inventory): { issues: Issue[]; matches: AlertMatch[] } {
  const versions = new Set(
    [minor(inv.version?.gitVersion), ...inv.nodes.map((n) => minor(n.status?.nodeInfo?.kubeletVersion))].filter(
      (v): v is string => !!v,
    ),
  );
  if (versions.size <= 1) {
    return { issues: [], matches: [] };
  }
  const id = `${ID}/version-mismatch`;
  const list = [...versions].sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
  return {
    issues: [
      {
        id,
        check: ID,
        severity: 'info',
        title: t('std.versionMismatch.title', { versions: list.join(', ') }),
        cause: t('std.versionMismatch.cause'),
        actions: [],
      },
    ],
    matches: [{ issueId: id, alerts: ['KubeVersionMismatch'], labels: {} }],
  };
}
