import { ClusterConfig, Light, Snapshot } from '../agent.model';
import { ClusterState } from '../status-store.service';

/** One open problem as the larger widgets list it. */
export interface WidgetProblem {
  /** The issue's title as the app shows it, at most MAX_PROBLEM_TITLE characters. */
  title: string;
  severity: 'critical' | 'warning';
}

/**
 * One cluster as the home-screen widget sees it. This is everything that
 * leaves the app for the widget: no address, no keys, no causes, no actions;
 * the titles of the three worst problems at most (docs/SECURITY.md). Native
 * code decodes exactly these fields (and the push extension / service writes
 * them from a sealed push), so add a field there too or not at all. Fields
 * added later are optional for the natives: a list stored by an older app
 * version still reads.
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
  /** The worst open problems, outages first, at most MAX_PROBLEMS (none when all is well). */
  problems: WidgetProblem[];
}

/** Long enough for any sensible name, short enough that a pasted essay stays in the app. */
const MAX_NAME = 64;
/** As many as the large widget lists; the same limits as a push's status (PUSH_STATUS_PROBLEMS, PUSH_STATUS_TITLE). */
export const MAX_PROBLEMS = 3;
export const MAX_PROBLEM_TITLE = 120;

function clip(text: string, max: number): string {
  const chars = Array.from(text);
  return chars.length <= max ? text : chars.slice(0, max - 1).join('') + '…';
}

export function widgetCluster(cluster: ClusterConfig, snapshot: Snapshot): WidgetCluster {
  const counted = snapshot.issues.filter((i) => !i.silencedUntil && i.severity !== 'info');
  const outages = counted.filter((i) => i.severity === 'critical');
  const warnings = counted.filter((i) => i.severity !== 'critical');
  return {
    id: cluster.id,
    name: cluster.name.slice(0, MAX_NAME),
    light: snapshot.light,
    critical: outages.length,
    warning: warnings.length,
    checkedAt: snapshot.checkedAt,
    demo: cluster.demo !== undefined,
    problems: [...outages, ...warnings].slice(0, MAX_PROBLEMS).map((i) => ({ title: clip(i.title, MAX_PROBLEM_TITLE), severity: i.severity === 'critical' ? 'critical' : 'warning' })),
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

/**
 * What to write: `next`, except where the stored entry of the same cluster
 * is newer. A sealed push updates the stored list from the background (the
 * iOS push extension, the Android messaging service) while the app holds an
 * older answer or none, and that newer state must not be written over. Name
 * and demo flag always come from the app.
 */
export function keepFresher(next: WidgetCluster[], stored: WidgetCluster[]): WidgetCluster[] {
  return next.map((entry) => {
    const other = stored.find((s) => s.id === entry.id);
    if (!other?.checkedAt || (entry.checkedAt && Date.parse(other.checkedAt) <= Date.parse(entry.checkedAt))) {
      return entry;
    }
    return { ...other, name: entry.name, demo: entry.demo };
  });
}

function validProblems(value: unknown): WidgetProblem[] | null {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    return null;
  }
  const ok = value.every((p) => typeof p === 'object' && p !== null && typeof p.title === 'string' && (p.severity === 'critical' || p.severity === 'warning'));
  return ok ? value.slice(0, MAX_PROBLEMS).map((p: WidgetProblem) => ({ title: clip(p.title, MAX_PROBLEM_TITLE), severity: p.severity })) : null;
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
        typeof c.demo === 'boolean' &&
        validProblems(c.problems) !== null,
    )
    .map(({ id, name, light, critical, warning, checkedAt, demo, problems }) => ({ id, name, light, critical, warning, checkedAt, demo, problems: validProblems(problems)! }));
}
