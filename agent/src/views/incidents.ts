/** The incident history: the episodes the agent followed, newest first. */
import type { Text } from '../i18n/text';
import type { Episode } from '../notify/digest';

export interface IncidentView {
  /** Unique per episode: the issue id and the start, so one issue that came back twice is two rows. */
  id: string;
  /** The issue's id, the same as in /status while it is open. */
  issueId: string;
  title: Text;
  severity: 'warning' | 'critical';
  module: string;
  /** ISO time. */
  start: string;
  /** ISO time; null while still open. */
  end: string | null;
  /** Until `end`, or until now while open. */
  durationMs: number;
  /** Someone silenced the issue during the episode. */
  silenced: boolean;
}

export interface IncidentsView {
  /** Since when the agent has watched (its start). Nothing before is known; the app says so. */
  coveredSince: string;
  /** The window asked for, 1 to 7. */
  days: number;
  incidents: IncidentView[];
}

const DAY = 86_400_000;

/** Episodes that touched the last `days` days, newest start first. */
export function buildIncidents(episodes: readonly Episode[], since: number, now: number, days: number): IncidentsView {
  const from = now - days * DAY;
  const incidents = episodes
    .filter((e) => e.end === null || e.end >= from)
    .sort((a, b) => b.start - a.start)
    .map((e) => ({
      id: `${e.id}@${new Date(e.start).toISOString()}`,
      issueId: e.id,
      title: e.title,
      severity: e.severity,
      module: e.module,
      start: new Date(e.start).toISOString(),
      end: e.end === null ? null : new Date(e.end).toISOString(),
      durationMs: Math.max(0, (e.end ?? now) - e.start),
      silenced: e.silenced,
    }));
  return { coveredSince: new Date(since).toISOString(), days, incidents };
}
