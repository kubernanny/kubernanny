import { describe, expect, it } from 'vitest';
import { IssueView } from '../status/status.service';
import { raw } from '../i18n/text';
import { EpisodeLog, MAX_EPISODES, MAX_EPISODES_PER_ISSUE, digestDue, formatDigest, weekKey } from './digest';

const hour = 3_600_000;
const issue = (id: string, severity: IssueView['severity'], since: number): IssueView => ({ id, check: 'pods', module: 'pods', severity, title: raw(`Problem ${id}`), cause: raw(''), actions: [], since: new Date(since).toISOString() });

describe('weekly report', () => {
  it('follows episodes from run to run, escalations included, hints never', () => {
    const log = new EpisodeLog(0);
    log.record([issue('a', 'warning', 0), issue('h', 'info', 0)], hour);
    log.record([issue('a', 'critical', 0)], 2 * hour);
    log.record([], 5 * hour);
    const week = log.lastWeek(6 * hour);
    expect(week).toEqual([{ id: 'a', title: raw('Problem a'), severity: 'critical', module: 'pods', start: 0, end: 5 * hour, silenced: false }]);
    // Ended episodes older than a week are forgotten.
    log.record([], 5 * hour + 8 * 24 * hour);
    expect(log.lastWeek(5 * hour + 8 * 24 * hour)).toEqual([]);
  });

  it('keeps the newest episodes of a flapping issue and a bounded number in all (review: unbounded)', () => {
    const log = new EpisodeLog(0);
    const minute = 60_000;
    // An issue that comes and goes every minute for a day, next to one that stays open.
    for (let i = 0; i < 2 * 60 * 24; i += 2) {
      log.record([issue('flap', 'warning', i * minute), issue('steady', 'critical', 0)], i * minute);
      log.record([issue('steady', 'critical', 0)], (i + 1) * minute);
    }
    const week = log.lastWeek(2 * 60 * 24 * minute);
    const flaps = week.filter((e) => e.id === 'flap');
    expect(flaps).toHaveLength(MAX_EPISODES_PER_ISSUE);
    expect(flaps.at(-1)!.start).toBe((2 * 60 * 24 - 2) * minute);
    expect(week.filter((e) => e.id === 'steady' && e.end === null)).toHaveLength(1);

    // Many different issues, each once: the total stays bounded, open ones are kept.
    const many = new EpisodeLog(0);
    for (let i = 0; i < MAX_EPISODES + 50; i++) {
      many.record([issue(`i${i}`, 'warning', i), issue('open', 'warning', 0)], i);
    }
    const all = many.lastWeek(MAX_EPISODES + 50);
    expect(all).toHaveLength(MAX_EPISODES);
    expect(all.some((e) => e.id === 'open' && e.end === null)).toBe(true);
    expect(all.some((e) => e.id === 'i0')).toBe(false);
  });

  it('writes the longest problems, or a calm line, and only counts in minimal mode', () => {
    const now = 10 * 24 * hour;
    const episodes = [
      { id: 'a', title: raw('Backup überfällig'), severity: 'warning' as const, module: 'cnpg', start: now - 30 * hour, end: now - 2 * hour, silenced: false },
      { id: 'b', title: raw('Node down'), severity: 'critical' as const, module: 'nodes', start: now - 3 * hour, end: null, silenced: false },
    ];
    const full = formatDigest('homelab', episodes, now, 0, 'full', 'de');
    expect(full.title).toBe('homelab: Wochenbericht');
    expect(full.body).toContain('2 Probleme in den letzten 7 Tagen, davon 1 kritisch. Jetzt offen: 1.');
    expect(full.body.indexOf('Backup überfällig')).toBeLessThan(full.body.indexOf('Node down'));
    expect(full.body).toContain('noch offen');
    expect(formatDigest('homelab', episodes, now, 0, 'minimal', 'de').body).not.toContain('Backup');
    expect(formatDigest('homelab', [], now, now - 2 * 24 * hour, 'full', 'de').body).toMatch(/^Keine Probleme in den letzten 7 Tagen \(seit 2 Tagen/);
    // The same report in English, as an agent with LANGUAGE=en sends it.
    const english = formatDigest('homelab', episodes, now, 0, 'full', 'en');
    expect(english.title).toBe('homelab: weekly report');
    expect(english.body).toContain('2 problems in the last 7 days, 1 of them critical. Open now: 1.');
    expect(english.body).toContain('Node down (3 h, still open)');
  });

  it('is due from the configured hour on the configured weekday, once per ISO week', () => {
    const monday9 = new Date(2026, 10, 23, 9, 5);
    expect(digestDue(monday9, 1, 9)).toBe(true);
    expect(digestDue(new Date(2026, 10, 23, 8, 59), 1, 9)).toBe(false);
    expect(digestDue(new Date(2026, 10, 24, 9, 5), 1, 9)).toBe(false);
    expect(weekKey(monday9)).toBe('2026-W48');
    expect(weekKey(new Date(2026, 10, 29, 23, 0))).toBe('2026-W48');
    expect(weekKey(new Date(2027, 0, 1))).toBe('2026-W53');
  });
});
