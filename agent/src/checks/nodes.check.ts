import { rawOr, t } from '../i18n/text';
import { Issue, ObjectMeta, Condition, condition } from './types';

export interface Node {
  metadata: ObjectMeta;
  spec?: { unschedulable?: boolean };
  status?: { conditions?: Condition[] };
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
