import { ClusterConfig, Light, Snapshot } from '../agent.model';
import { ClusterState } from '../status-store.service';

/**
 * One cluster as the home-screen widget sees it. This is everything that
 * leaves the app for the widget: no address, no keys, no issue texts, no
 * component names. Native code decodes exactly these fields, so add a field
 * there too (and to docs/SECURITY.md) or not at all.
 */
export interface WidgetCluster {
  /** The app's id, for the kubernanny://cluster?id=… link a tap opens. */
  id: string;
  /** The name the person gave the cluster in the app. */
  name: string;
  light: Light;
  /** Open outages and warnings, counted like the app's headline (silenced and hints left out). */
  critical: number;
  warning: number;
  /** The agent's last check (ISO time), or null before its first run. */
  checkedAt: string | null;
  /** A built-in demo cluster: the widget marks it as such. */
  demo: boolean;
}

/** Long enough for any sensible name, short enough that a pasted essay stays in the app. */
const MAX_NAME = 64;

export function widgetCluster(cluster: ClusterConfig, snapshot: Snapshot): WidgetCluster {
  const counted = snapshot.issues.filter((i) => !i.silencedUntil && i.severity !== 'info');
  const critical = counted.filter((i) => i.severity === 'critical').length;
  return {
    id: cluster.id,
    name: cluster.name.slice(0, MAX_NAME),
    light: snapshot.light,
    critical,
    warning: counted.length - critical,
    checkedAt: snapshot.checkedAt,
    demo: cluster.demo !== undefined,
  };
}

/**
 * The list the widgets should hold next, in the app's cluster order.
 * Off globally: nothing. A cluster switched off or removed: left out, so the
 * next write deletes it from the device. A cluster without an answer yet
 * (the app just started, or the agent is out of reach) keeps what the widget
 * showed before, only renamed if the name changed: the widget then ages and
 * greys out on its own instead of going blank.
 */
export function nextWidgetList(previous: WidgetCluster[], clusters: ClusterConfig[], states: Record<string, ClusterState>, allOff: boolean): WidgetCluster[] {
  if (allOff) {
    return [];
  }
  const out: WidgetCluster[] = [];
  for (const cluster of clusters) {
    if (cluster.widgetOff) {
      continue;
    }
    const snapshot = states[cluster.id]?.snapshot;
    const before = previous.find((p) => p.id === cluster.id);
    if (snapshot) {
      out.push(widgetCluster(cluster, snapshot));
    } else if (before) {
      out.push({ ...before, name: cluster.name.slice(0, MAX_NAME) });
    }
  }
  return out;
}

/** Reads back what native storage returned; anything malformed is dropped rather than trusted. */
export function validWidgetList(value: unknown): WidgetCluster[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const lights: Light[] = ['green', 'yellow', 'red', 'unknown'];
  return value
    .filter(
      (c): c is WidgetCluster =>
        typeof c === 'object' &&
        c !== null &&
        typeof c.id === 'string' &&
        typeof c.name === 'string' &&
        lights.includes(c.light) &&
        Number.isInteger(c.critical) &&
        Number.isInteger(c.warning) &&
        (c.checkedAt === null || typeof c.checkedAt === 'string') &&
        typeof c.demo === 'boolean',
    )
    .map(({ id, name, light, critical, warning, checkedAt, demo }) => ({ id, name, light, critical, warning, checkedAt, demo }));
}
