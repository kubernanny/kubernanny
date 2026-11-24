import { AgentInfo, BackupsView, EventView, HistoryView, IncidentsView, Logs, NetworkView, NodeView, SettingsView, Snapshot, StorageView, WorkloadView } from '../agent.model';

export type DemoScenario = 'broken' | 'warning' | 'healthy';
export const DEMO_SCENARIOS: readonly DemoScenario[] = ['broken', 'warning', 'healthy'];

/** How the three demo clusters appear in the list: one per state of the light. */
export const DEMO_LABELS: Record<DemoScenario, { cluster: string; name: string }> = {
  broken: { cluster: 'homelab', name: 'homelab' },
  warning: { cluster: 'office', name: 'office' },
  healthy: { cluster: 'staging', name: 'staging' },
};

/** One recording of a demo agent (agent/scripts/export-demo.mjs). */
export interface DemoData {
  generatedAt: string;
  scenario: DemoScenario;
  status: Snapshot;
  info: AgentInfo;
  nodes: NodeView[];
  workloads: WorkloadView[];
  storage: StorageView;
  network: NetworkView;
  events: EventView[];
  history: Record<6 | 24 | 168, HistoryView>;
  settings: SettingsView;
  logs: Record<string, Logs>;
  /** Recordings from agent 0.4 on. */
  incidents?: IncidentsView;
  backups?: BackupsView;
}

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
/** Chart points are [ms, value]; anything after 2020 in ms is a time. */
const MS_AFTER_2020 = 1_577_836_800_000;

/**
 * Moves every time in a recording by `delta` ms, so "seit 12 Minuten" and
 * the charts read as if the recording were made just now.
 */
export function shiftTimes<T>(value: T, delta: number): T {
  if (typeof value === 'string') {
    return (ISO.test(value) ? new Date(Date.parse(value) + delta).toISOString() : value) as T;
  }
  if (Array.isArray(value)) {
    if (value.length === 2 && typeof value[0] === 'number' && typeof value[1] !== 'string' && value[0] > MS_AFTER_2020) {
      return [value[0] + delta, value[1]] as T;
    }
    return value.map((v) => shiftTimes(v, delta)) as T;
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, shiftTimes(v, delta)])) as T;
  }
  return value;
}

/**
 * The recording is made right after the demo agent starts, so every issue
 * would read "gerade neu". Gives each a stable age between 12 minutes and
 * about 9 hours, derived from its id, so the demo looks like a real night.
 */
export function ageIssues<T extends { id: string; since: string }>(issues: T[], now: number): T[] {
  return issues.map((issue) => {
    let hash = 0;
    for (const char of issue.id) {
      hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
    }
    const minutes = 12 + (hash % 520);
    return { ...issue, since: new Date(now - minutes * 60_000).toISOString() };
  });
}
