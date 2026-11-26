import { rawOr, t } from '../i18n/text';
import { Issue, ObjectMeta, Condition, ageText, condition } from './types';

export interface Node {
  metadata: ObjectMeta & { managedFields?: { manager?: string; operation?: string; time?: string; fieldsV1?: { 'f:spec'?: { 'f:unschedulable'?: unknown } } }[] };
  spec?: { unschedulable?: boolean };
  status?: { conditions?: Condition[] };
}

/** How long a Ready node may stay cordoned before uncordoning it is offered. */
const CORDONED_AFTER_MS = 30 * 60_000;

/**
 * When the node was cordoned: the newest managedFields entry that owns
 * `spec.unschedulable` (kept by the inventory without its field list), else
 * when this agent first saw it cordoned.
 */
export function cordonedSince(node: Node, firstSeen: number | undefined): number | undefined {
  // The inventory keeps only the owners of the field, without fieldsV1; a full object (no watch cache) still has them.
  const owners = (node.metadata.managedFields ?? []).filter((m) => m.fieldsV1 === undefined || m.fieldsV1['f:spec']?.['f:unschedulable'] !== undefined);
  const times = owners.map((m) => Date.parse(m.time ?? '')).filter(Number.isFinite);
  return times.length ? Math.max(...times) : firstSeen;
}

/**
 * Ready nodes cordoned for a while that nothing is working on: no kured
 * reboot holds the lock for them, and no pod on them is being evicted (a
 * drain in progress). A node someone forgot to uncordon after maintenance
 * takes no new pods, which shows only once the others fill up.
 */
export function evaluateCordoned(
  nodes: Node[],
  pods: { metadata: { deletionTimestamp?: string }; spec?: { nodeName?: string } }[],
  kuredHolders: ReadonlySet<string>,
  firstSeen: ReadonlyMap<string, number>,
  now: Date,
): Issue[] {
  const draining = new Set(pods.filter((p) => p.metadata.deletionTimestamp && p.spec?.nodeName).map((p) => p.spec!.nodeName!));
  const issues: Issue[] = [];
  for (const node of nodes) {
    const name = node.metadata.name;
    if (node.spec?.unschedulable !== true || condition(node.status?.conditions, 'Ready')?.status !== 'True' || kuredHolders.has(name) || draining.has(name)) {
      continue;
    }
    const since = cordonedSince(node, firstSeen.get(name));
    if (since === undefined || now.getTime() - since < CORDONED_AFTER_MS) {
      continue;
    }
    issues.push({
      id: `nodes/${name}/cordoned`,
      check: 'nodes',
      severity: 'warning',
      title: t('nodes.cordoned.title', { node: name, age: ageText(now.getTime() - since) }),
      cause: t('nodes.cordoned.cause'),
      actions: [{ type: 'uncordon', node: name }],
    });
  }
  return issues;
}

/**
 * The nodes kured is rebooting: the holders of the lock it writes on its
 * DaemonSet (`weave.works/kured-node-lock`, one holder or, with
 * --concurrency, a list). Anyone who can annotate that DaemonSet can write
 * it; it only ever keeps an uncordon from being offered.
 */
export function kuredLockHolders(daemonsets: { metadata: ObjectMeta }[]): Set<string> {
  const out = new Set<string>();
  for (const ds of daemonsets) {
    const raw = ds.metadata.annotations?.['weave.works/kured-node-lock'];
    if (!raw) {
      continue;
    }
    try {
      const parsed = JSON.parse(raw) as { nodeID?: unknown; locks?: { nodeID?: unknown }[] };
      for (const h of Array.isArray(parsed.locks) ? parsed.locks : [parsed]) {
        if (typeof h?.nodeID === 'string' && h.nodeID) {
          out.add(h.nodeID.slice(0, 253));
        }
      }
    } catch {
      // Not kured's format: nothing held.
    }
  }
  return out;
}

const PRESSURE = ['MemoryPressure', 'DiskPressure', 'PIDPressure'] as const;

/**
 * NotReady is critical, unless the node is cordoned: kured drains a node
 * before its nightly reboot, and a planned reboot at 04:00 is no emergency.
 */
export function evaluateNodes(nodes: Node[]): Issue[] {
  const issues: Issue[] = [];
  for (const node of nodes) {
    const name = node.metadata.name;
    const ready = condition(node.status?.conditions, 'Ready');
    const cordoned = node.spec?.unschedulable === true;
    if (ready?.status !== 'True') {
      issues.push({
        id: `nodes/${name}/not-ready`,
        check: 'nodes',
        severity: cordoned ? 'warning' : 'critical',
        title: t('nodes.notReady.title', { node: name }),
        cause: cordoned ? t('nodes.notReady.cordoned', { message: ready?.message }) : rawOr(ready?.message, t('nodes.notReady.silent')),
        actions: [],
      });
      continue;
    }
    for (const type of PRESSURE) {
      const c = condition(node.status?.conditions, type);
      if (c?.status === 'True') {
        issues.push({
          id: `nodes/${name}/${type}`,
          check: 'nodes',
          severity: 'warning',
          title: t('nodes.pressure.title', { node: name, type }),
          cause: rawOr(c.message, t('nodes.pressure.cause', { type })),
          actions: [],
        });
      }
    }
  }
  return issues;
}
