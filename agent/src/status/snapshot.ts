import { condition, Issue, IssueSeverity, worst } from '../checks/types';
import { Text } from '../i18n/text';
import { cpuMilli, Inventory, parseQuantity } from '../inventory/inventory';
import { ModuleView } from '../modules/types';
import { buildNodes } from '../views/nodes';
import { addResources, holdsResources, NO_RESOURCES, podResources } from '../views/resources';

/** What one run of the checks produces, and the rules that turn issues into a light and a score. */

export type Light = 'green' | 'yellow' | 'red' | 'unknown';

export interface IssueView extends Issue {
  /** ISO time the agent first saw this issue (since its own start). */
  since: string;
  /** Module the issue came from, for grouping in the app. */
  module: string;
  /** Set while someone silenced the issue: shown, but no light, score or notification. */
  silencedUntil?: string;
}

export interface Overview {
  nodes: { ready: number; total: number };
  pods: { running: number; total: number };
  /** Use from metrics-server; requests and limits (where set) summed over the scheduled pods. */
  cpu: { usedMilli: number; allocatableMilli: number; requestedMilli?: number; limitMilli?: number } | null;
  memory: { used: number; allocatable: number; requested?: number; limit?: number } | null;
  volumes: { bound: number; total: number };
  ingresses: number;
  namespaces: number;
  workloads: number;
  components: number;
  prometheus: boolean;
  metricsServer: boolean;
  /** Per node: use, and the requests and limits of the pods scheduled there, against allocatable. */
  perNode?: NodeResources[];
}

export interface NodeResources {
  name: string;
  cpu: { usedMilli: number | null; allocatableMilli: number; requestedMilli: number; limitMilli: number };
  memory: { used: number | null; allocatable: number; requested: number; limit: number };
  podsWithoutLimit: { cpu: number; memory: number };
}

export interface Snapshot {
  cluster: string;
  /** So the app can tell when the agent is older than itself. */
  agentVersion: string;
  /** The image tag and git commit CI baked in (KUBERNANNY_BUILD, KUBERNANNY_COMMIT); absent in local builds. */
  agentBuild?: string;
  agentCommit?: string;
  light: Light;
  /** 0..100, see scoreFor. */
  score: number;
  checkedAt: string | null;
  durationMs: number | null;
  kubernetes: { version?: string; distribution: string } | null;
  overview: Overview | null;
  modules: ModuleView[];
  issues: IssueView[];
  /** Set during a maintenance window: no notifications until then. */
  maintenanceUntil?: string;
  /** Set when the whole run failed (API unreachable, RBAC); `checkedAt` stays the last run that read the cluster. */
  error?: Text;
  /** ISO time of the first of the failed runs in a row; absent while runs succeed. */
  failingSince?: string;
  /**
   * ISO time of the next scheduled run: the next interval tick, or sooner
   * when a watch event has an early run waiting. Absent until the schedule
   * runs; the app then shows no countdown.
   */
  nextCheckAt?: string;
}

export const SEVERITY_RANK: Record<IssueSeverity, number> = { critical: 0, warning: 1, info: 2 };

export function lightFor(modules: Pick<ModuleView, 'status'>[], issues: Pick<Issue, 'severity'>[]): Light {
  if (modules.length === 0) {
    return 'unknown';
  }
  const level = worst(issues.map((i) => i.severity));
  if (level === 'critical') {
    return 'red';
  }
  // A module that could not run is not "all fine".
  if (level === 'warning' || modules.some((m) => m.status === 'error')) {
    return 'yellow';
  }
  return 'green';
}

/**
 * Each critical issue takes 18 % of what is left, each warning 5 %: one
 * problem is clearly visible, and a cluster with many still differs from
 * one with a few more (a linear penalty sat at 0 for most real clusters).
 */
export function scoreFor(issues: Pick<Issue, 'severity'>[]): number {
  return Math.round(
    issues.reduce((s, i) => s * (i.severity === 'critical' ? 0.82 : i.severity === 'warning' ? 0.95 : 1), 100),
  );
}

/** The numbers at the top of a cluster: nodes, pods, CPU and memory (metrics-server), volumes, counts. */
export function buildOverview(inv: Inventory, components: number, prometheus: boolean): Overview {
  let cpuAlloc = 0;
  let memAlloc = 0;
  let cpuUsed = 0;
  let memUsed = 0;
  for (const n of inv.nodes) {
    cpuAlloc += cpuMilli(n.status?.allocatable?.cpu);
    memAlloc += parseQuantity(n.status?.allocatable?.memory);
    cpuUsed += inv.nodeUsage?.get(n.metadata.name)?.cpuMilli ?? 0;
    memUsed += inv.nodeUsage?.get(n.metadata.name)?.memBytes ?? 0;
  }
  const metrics = inv.nodeUsage !== null && inv.nodeUsage.size > 0;
  const res = inv.pods.filter(holdsResources).map(podResources).reduce(addResources, NO_RESOURCES);
  return {
    nodes: {
      ready: inv.nodes.filter((n) => condition(n.status?.conditions, 'Ready')?.status === 'True').length,
      total: inv.nodes.length,
    },
    pods: {
      running: inv.pods.filter((p) => p.status?.phase === 'Running').length,
      total: inv.pods.filter((p) => p.status?.phase !== 'Succeeded').length,
    },
    cpu: metrics
      ? {
          usedMilli: cpuUsed,
          allocatableMilli: cpuAlloc,
          requestedMilli: res.cpuRequestMilli,
          limitMilli: res.cpuLimitMilli,
        }
      : null,
    memory: metrics ? { used: memUsed, allocatable: memAlloc, requested: res.memRequest, limit: res.memLimit } : null,
    volumes: { bound: inv.pvcs.filter((p) => p.status?.phase === 'Bound').length, total: inv.pvcs.length },
    ingresses: inv.ingresses.length,
    namespaces: inv.namespaces.length,
    workloads: inv.deployments.length + inv.statefulsets.length + inv.daemonsets.length,
    components,
    prometheus,
    metricsServer: metrics,
    perNode: buildNodes(inv, {}).map((n) => ({
      name: n.name,
      cpu: n.cpu,
      memory: n.memory,
      podsWithoutLimit: n.podsWithoutLimit,
    })),
  };
}
