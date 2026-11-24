/**
 * Gatus and Uptime Kuma watch services from the outside; when they say an
 * endpoint is down, that is worth an issue. Both answers come over plain
 * in-cluster HTTP, so everything here is parsed defensively: a field missing
 * or of another type counts as "no verdict", never as down.
 */
import { t } from '../i18n/text';
import { Issue } from './types';

// ---------- Gatus: GET /api/v1/endpoints/statuses ----------

export interface GatusResult {
  success?: boolean;
  timestamp?: string;
  status?: number;
  errors?: string[];
  conditionResults?: { condition?: string; success?: boolean }[];
}

export interface GatusEndpointStatus {
  name?: string;
  group?: string;
  key?: string;
  /** Oldest first; Gatus answers the latest page of results. */
  results?: GatusResult[];
}

export interface UptimeVerdict {
  issues: Issue[];
  up: number;
  down: number;
  /** Without a result yet, pending or in maintenance. */
  other: number;
}

/** The newest entry by its time field; the last one when times are missing (both tools answer oldest first). */
function newest<T>(list: T[] | undefined, time: (x: T) => string | undefined): T | undefined {
  if (!Array.isArray(list) || list.length === 0) {
    return undefined;
  }
  return list.reduce((a, b) => ((time(b) ?? '') >= (time(a) ?? '') ? b : a));
}

/** Endpoints whose newest result failed, one warning per Gatus group. */
export function evaluateGatus(statuses: unknown): UptimeVerdict {
  const list = Array.isArray(statuses) ? (statuses as GatusEndpointStatus[]) : [];
  const downByGroup = new Map<string, { names: string[]; error?: string; condition?: string }>();
  let up = 0;
  let other = 0;
  for (const endpoint of list) {
    const last = newest(endpoint?.results, (r) => (typeof r?.timestamp === 'string' ? r.timestamp : undefined));
    if (typeof last?.success !== 'boolean') {
      other++;
      continue;
    }
    if (last.success) {
      up++;
      continue;
    }
    const group = typeof endpoint.group === 'string' ? endpoint.group : '';
    const entry = downByGroup.get(group) ?? { names: [] };
    entry.names.push(String(endpoint.name ?? endpoint.key ?? '?').slice(0, 80));
    // What Gatus itself says went wrong for the first one: an error, else the first condition not met.
    if (entry.names.length === 1) {
      entry.error = Array.isArray(last.errors) ? last.errors.find((e) => typeof e === 'string')?.slice(0, 200) : undefined;
      entry.condition = Array.isArray(last.conditionResults) ? last.conditionResults.find((c) => c?.success === false && typeof c.condition === 'string')?.condition?.slice(0, 200) : undefined;
    }
    downByGroup.set(group, entry);
  }
  const issues: Issue[] = [...downByGroup].map(([group, { names, error, condition }]) => ({
    id: `gatus/group/${group || '-'}`,
    check: 'gatus',
    severity: 'warning',
    title: group ? t('gatus.down.title', { group, n: names.length }) : t('gatus.down.titleUngrouped', { n: names.length }),
    cause: t('gatus.down.cause', { endpoints: names, error, condition }),
    actions: [],
  }));
  const down = [...downByGroup.values()].reduce((s, g) => s + g.names.length, 0);
  return { issues, up, down, other };
}

// ---------- Uptime Kuma: GET /api/status-page/<slug> and /api/status-page/heartbeat/<slug> ----------

export interface KumaStatusPage {
  publicGroupList?: { id?: number; name?: string; monitorList?: { id?: number; name?: string }[] }[];
}

export interface KumaHeartbeats {
  /** Monitor id → heartbeats, oldest first. Status 0 down, 1 up, 2 pending, 3 maintenance. */
  heartbeatList?: Record<string, { status?: number; time?: string }[]>;
}

const KUMA_DOWN = 0;
const KUMA_UP = 1;

/** Monitors of the status page whose newest heartbeat is "down", one warning per status page group. */
export function evaluateUptimeKuma(page: unknown, beats: unknown): UptimeVerdict {
  const groups = Array.isArray((page as KumaStatusPage | null)?.publicGroupList) ? (page as KumaStatusPage).publicGroupList! : [];
  const heartbeats = (beats as KumaHeartbeats | null)?.heartbeatList;
  const issues: Issue[] = [];
  let up = 0;
  let down = 0;
  let other = 0;
  for (const [index, group] of groups.entries()) {
    const names: string[] = [];
    for (const monitor of Array.isArray(group?.monitorList) ? group.monitorList : []) {
      const list = heartbeats && typeof heartbeats === 'object' ? heartbeats[String(monitor?.id)] : undefined;
      const status = newest(list, (b) => (typeof b?.time === 'string' ? b.time : undefined))?.status;
      if (status === KUMA_DOWN) {
        names.push(String(monitor.name ?? monitor.id).slice(0, 80));
      } else if (status === KUMA_UP) {
        up++;
      } else {
        other++;
      }
    }
    if (names.length > 0) {
      down += names.length;
      const name = typeof group.name === 'string' && group.name ? group.name : String(index + 1);
      issues.push({
        // The group's id is stable across renames; its position only when Uptime Kuma sends none.
        id: `uptime-kuma/group/${typeof group.id === 'number' ? group.id : `#${index}`}`,
        check: 'uptime-kuma',
        severity: 'warning',
        title: t('uptimeKuma.down.title', { group: name, n: names.length }),
        cause: t('uptimeKuma.down.cause', { monitors: names }),
        actions: [],
      });
    }
  }
  return { issues, up, down, other };
}
