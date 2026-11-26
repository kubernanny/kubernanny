/** The Events tab: recent Kubernetes warnings, newest first, one row per object and reason. */
import { podOwner } from '../checks/pods.check';
import { Inventory } from '../inventory/inventory';

export interface EventView {
  /** When it was last seen (the newest of the grouped events). */
  time: string;
  namespace?: string;
  kind?: string;
  name?: string;
  reason?: string;
  /** The newest event's message. */
  message?: string;
  /** How often it happened, summed over the grouped events. */
  count: number;
  /** When the oldest of the grouped events was first seen. */
  firstSeen: string;
  /** How many Event objects were merged into this row (1: none). */
  events: number;
  /** The Deployment, StatefulSet or DaemonSet the object belongs to (a pod's or ReplicaSet's owner), for a link to it. */
  workload?: { kind: string; name: string };
}

/** The workload behind a Pod or ReplicaSet the event is about; a workload itself is its own. */
function workloadOf(
  inv: Inventory,
  namespace: string | undefined,
  kind: string | undefined,
  name: string | undefined,
): { kind: string; name: string } | undefined {
  if (!name || !kind) {
    return undefined;
  }
  if (kind === 'Deployment' || kind === 'StatefulSet' || kind === 'DaemonSet') {
    return { kind, name };
  }
  if (kind === 'Pod') {
    const pod = inv.pods.find((p) => p.metadata.namespace === namespace && p.metadata.name === name);
    const owner = pod ? podOwner(pod) : undefined;
    return owner && owner.kind !== 'Pod' ? { kind: owner.kind, name: owner.name } : undefined;
  }
  if (kind === 'ReplicaSet') {
    // A ReplicaSet is named after its Deployment plus the pod-template-hash.
    const deployment = inv.deployments.find(
      (d) =>
        d.metadata.namespace === namespace &&
        name.startsWith(`${d.metadata.name}-`) &&
        !name.slice(d.metadata.name.length + 1).includes('-'),
    );
    return deployment ? { kind: 'Deployment', name: deployment.metadata.name } : undefined;
  }
  return undefined;
}

/**
 * Kubernetes counts repeats of one event itself, but writes a new Event
 * object whenever the message changes ("0/3 nodes are available: …" with
 * other numbers), so one stuck pod can fill the list. Warnings about the same
 * object with the same reason become one row.
 */
export function buildEvents(inv: Inventory, limit = 200): EventView[] {
  const groups = new Map<string, EventView>();
  for (const e of inv.events) {
    const time =
      e.series?.lastObservedTime ??
      e.lastTimestamp ??
      e.eventTime ??
      e.firstTimestamp ??
      e.metadata.creationTimestamp ??
      '';
    const first = e.firstTimestamp ?? e.eventTime ?? e.metadata.creationTimestamp ?? time;
    const row: EventView = {
      time,
      namespace: e.involvedObject?.namespace ?? e.metadata.namespace,
      kind: e.involvedObject?.kind,
      name: e.involvedObject?.name,
      reason: e.reason,
      message: e.message,
      count: e.series?.count ?? e.count ?? 1,
      firstSeen: first,
      events: 1,
    };
    const workload = workloadOf(inv, row.namespace, row.kind, row.name);
    if (workload) {
      row.workload = workload;
    }
    const key = JSON.stringify([row.namespace, row.kind, row.name, row.reason]);
    const seen = groups.get(key);
    if (!seen) {
      groups.set(key, row);
      continue;
    }
    const newer = row.time.localeCompare(seen.time) > 0;
    groups.set(key, {
      ...(newer ? row : seen),
      count: seen.count + row.count,
      firstSeen: row.firstSeen && (!seen.firstSeen || row.firstSeen < seen.firstSeen) ? row.firstSeen : seen.firstSeen,
      events: seen.events + 1,
    });
  }
  return [...groups.values()].sort((a, b) => b.time.localeCompare(a.time)).slice(0, limit);
}
