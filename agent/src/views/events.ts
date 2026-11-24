/** The Events tab: recent Kubernetes warnings, newest first, one row per object and reason. */
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
    const time = e.series?.lastObservedTime ?? e.lastTimestamp ?? e.eventTime ?? e.firstTimestamp ?? e.metadata.creationTimestamp ?? '';
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
