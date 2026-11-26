import { ageText } from '../checks/types';
import { Lang, render, t, Text } from '../i18n/text';
import type { IssueView } from '../status/status.service';

/** One stretch of time an issue was open. */
export interface Episode {
  id: string;
  title: Text;
  severity: 'warning' | 'critical';
  /** The module that reported it. */
  module: string;
  start: number;
  /** null while still open. */
  end: number | null;
  /** Someone silenced the issue at some point during this episode. */
  silenced: boolean;
}

const WEEK = 7 * 86_400_000;
/** Ended episodes kept per issue: a flapping issue opens one every time it comes back (once a minute at worst). */
export const MAX_EPISODES_PER_ISSUE = 100;
/** Episodes kept in all; past it the oldest ended ones go first. */
export const MAX_EPISODES = 5_000;

/**
 * Follows issues from run to run and keeps the episodes of the last week
 * (hints never count). Kept in memory and, with `history.persist` on, in the
 * ConfigMap `kubernanny-history` (history/history-store.ts), so a restart
 * continues the week instead of starting it again.
 */
export class EpisodeLog {
  private readonly episodes: Episode[];
  /** When the agent first started watching (the stored value after a restart); `history` lets the demo pretend a week. */
  private sinceValue: number;

  constructor(now: number, history: { since: number; episodes: Episode[] } | null = null) {
    this.sinceValue = history?.since ?? now;
    this.episodes = history ? history.episodes.map((e) => ({ ...e })) : [];
  }

  get since(): number {
    return this.sinceValue;
  }

  /** Every episode kept, oldest start first (copies). */
  all(): Episode[] {
    return this.episodes.map((e) => ({ ...e }));
  }

  /**
   * Takes in what was stored (at start, or what the previous pod wrote last
   * on a takeover). The earlier `since` wins. An episode this pod also has
   * (same issue, same start) keeps this pod's version unless only the stored
   * one has ended: then it ends at the stored time, which is the earlier one.
   * Episodes only the store knows are added; an open one this pod has open
   * too (seen first at another time) stays one episode, from the earlier start.
   */
  merge(stored: { since: number; episodes: Episode[] }, now: number): void {
    this.sinceValue = Math.min(this.sinceValue, stored.since);
    const mine = new Map(this.episodes.map((e) => [`${e.id}@${e.start}`, e]));
    const openHere = new Map(this.episodes.filter((e) => e.end === null).map((e) => [e.id, e]));
    for (const s of stored.episodes) {
      // Both pods saw the issue open, each since its own first sight: one episode, from the earlier start.
      const same = s.end === null ? openHere.get(s.id) : undefined;
      const own = mine.get(`${s.id}@${s.start}`) ?? same;
      if (same && same.start > s.start) {
        same.start = s.start;
      }
      if (!own) {
        this.episodes.push({ ...s });
      } else if (own.end !== null && s.end !== null) {
        own.end = Math.min(own.end, s.end);
      }
      if (own && s.severity === 'critical') {
        own.severity = 'critical';
      }
      if (own && s.silenced) {
        own.silenced = true;
      }
    }
    this.episodes.sort((a, b) => a.start - b.start);
    this.forgetOld(now);
    this.cap();
  }

  record(issues: IssueView[], now: number): void {
    const current = new Map(issues.filter((i) => i.severity !== 'info').map((i) => [i.id, i]));
    for (const e of this.episodes) {
      if (e.end === null) {
        const issue = current.get(e.id);
        if (!issue) {
          e.end = now;
        } else {
          if (issue.severity === 'critical') {
            e.severity = 'critical';
          }
          if (issue.silencedUntil) {
            e.silenced = true;
          }
        }
        current.delete(e.id);
      }
    }
    for (const issue of current.values()) {
      const since = Date.parse(issue.since);
      this.episodes.push({
        id: issue.id,
        title: issue.title,
        severity: issue.severity === 'critical' ? 'critical' : 'warning',
        module: issue.module,
        start: Number.isFinite(since) ? since : now,
        end: null,
        silenced: Boolean(issue.silencedUntil),
      });
    }
    this.forgetOld(now);
    this.cap();
  }

  /** Forgets what ended more than a week ago. */
  private forgetOld(now: number): void {
    for (let i = this.episodes.length - 1; i >= 0; i--) {
      const end = this.episodes[i]!.end;
      if (end !== null && end < now - WEEK) {
        this.episodes.splice(i, 1);
      }
    }
  }

  /** Bounds the log: the newest MAX_EPISODES_PER_ISSUE ended episodes per issue, MAX_EPISODES in all (oldest ended first, then oldest). */
  private cap(): void {
    const ended = new Map<string, number>();
    // Newest first: the episodes are in the order they started.
    const kept = [...this.episodes].reverse().filter((e) => {
      if (e.end === null) {
        return true;
      }
      const n = (ended.get(e.id) ?? 0) + 1;
      ended.set(e.id, n);
      return n <= MAX_EPISODES_PER_ISSUE;
    });
    kept.reverse();
    let excess = kept.length - MAX_EPISODES;
    if (excess > 0) {
      for (let i = 0; i < kept.length && excess > 0; i++) {
        if (kept[i]!.end !== null) {
          kept.splice(i--, 1);
          excess--;
        }
      }
      kept.splice(0, Math.max(0, excess));
    }
    if (kept.length !== this.episodes.length) {
      this.episodes.splice(0, this.episodes.length, ...kept);
    }
  }

  lastWeek(now: number): Episode[] {
    return this.episodes.filter((e) => e.end === null || e.end >= now - WEEK);
  }
}

/** "2026-W48" for the week of `date` in the agent's time zone (TZ), so one report per week. */
export function weekKey(date: Date): string {
  const d = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const day = (d.getDay() + 6) % 7;
  d.setDate(d.getDate() - day + 3);
  const firstThursday = new Date(d.getFullYear(), 0, 4);
  const week =
    1 + Math.round(((d.getTime() - firstThursday.getTime()) / 86_400_000 - 3 + ((firstThursday.getDay() + 6) % 7)) / 7);
  return `${d.getFullYear()}-W${String(week).padStart(2, '0')}`;
}

/** True from the configured hour on the configured weekday (0 = Sunday), local time. */
export function digestDue(now: Date, weekday: number, hour: number): boolean {
  return now.getDay() === weekday && now.getHours() >= hour;
}

export function formatDigest(
  cluster: string,
  episodes: Episode[],
  now: number,
  coveredSince: number,
  detail: 'full' | 'minimal',
  lang: Lang,
): { title: string; body: string; priority: number; tags: string } {
  const s = (text: Text) => render(text, lang);
  const critical = episodes.filter((e) => e.severity === 'critical').length;
  const open = episodes.filter((e) => e.end === null);
  const partial = now - coveredSince < WEEK ? s(t('digest.partial', { age: ageText(now - coveredSince) })) : '';
  const title = s(t('digest.title', { cluster }));
  if (episodes.length === 0) {
    return { title, body: s(t('digest.none', { partial })), priority: 2, tags: 'calendar' };
  }
  const lines = [s(t('digest.summary', { n: episodes.length, partial, critical, open: open.length }))];
  if (detail === 'full') {
    const longest = [...episodes].sort((a, b) => (b.end ?? now) - b.start - ((a.end ?? now) - a.start)).slice(0, 3);
    lines.push(s(t('digest.longest')));
    for (const e of longest) {
      const episode = { title: e.title, duration: ageText((e.end ?? now) - e.start) };
      lines.push(
        `${e.severity === 'critical' ? '🔴' : '🟡'} ${s(e.end === null ? t('digest.episodeOpen', episode) : t('digest.episode', episode))}`,
      );
    }
  }
  return { title, body: lines.join('\n'), priority: open.length > 0 ? 3 : 2, tags: 'calendar' };
}
