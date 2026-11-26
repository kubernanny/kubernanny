import { IncidentsView, IncidentView, ModuleView, Tone } from '../core/agent.model';
import { clockTime, dateTime, span, startOfDay } from '../core/format';
import { Translator } from '../i18n/translator';

const DAY = 86_400_000;
/** Rows on the overview before "show all". */
export const HISTORY_PREVIEW = 4;

export interface DayCell {
  key: number;
  /** "Mo" / "Mon" under the cell. */
  label: string;
  /** critical, warning, ok (no issue), muted (not watched yet). */
  tone: Tone;
  count: number;
  /** Read out by screen readers and shown on hover. */
  title: string;
  today: boolean;
}

export interface IncidentRow {
  id: string;
  title: string;
  tone: Tone;
  icon: string;
  /** "Argo CD, 14:05" */
  meta: string;
  /** "2 h 14 min" or "noch offen, seit 3 h". */
  duration: string;
  open: boolean;
  silenced: boolean;
}

export interface IncidentDay {
  key: number;
  /** "Heute", "Gestern", "Sa., 22.11." */
  label: string;
  rows: IncidentRow[];
}

export interface HistoryVM {
  days: DayCell[];
  /** All incidents grouped by the day they started, newest first. */
  groups: IncidentDay[];
  /** The first few, for the overview before "show all". */
  preview: IncidentDay[];
  total: number;
  /** "12 Probleme in 7 Tagen" */
  summary: string;
  /** Set when the agent has watched for less than the window. */
  coveredNote: string | null;
}

/** Whether an incident was going on at some point of [from, to). */
function touches(i: IncidentView, from: number, to: number, now: number): boolean {
  const start = Date.parse(i.start);
  const end = i.end ? Date.parse(i.end) : now;
  return start < to && end >= from;
}

function dayLabel(dayStart: number, today: number, tr: Translator): string {
  if (dayStart === today) {
    return tr.t('history.today');
  }
  if (dayStart === startOfDay(today - DAY / 2)) {
    return tr.t('history.yesterday');
  }
  return new Date(dayStart).toLocaleDateString(tr.locale, {
    weekday: 'short',
    day: 'numeric',
    month: 'numeric',
  });
}

/** Groups rows by start day, keeping their order (newest first). */
function byDay(
  rows: { row: IncidentRow; day: number }[],
  today: number,
  tr: Translator,
): IncidentDay[] {
  const groups: IncidentDay[] = [];
  for (const { row, day } of rows) {
    const last = groups[groups.length - 1];
    if (last?.key === day) {
      last.rows.push(row);
    } else {
      groups.push({ key: day, label: dayLabel(day, today, tr), rows: [row] });
    }
  }
  return groups;
}

/**
 * The incident history: a strip of the last seven days, each coloured by its
 * worst incident, and the incidents by the day they started. Durations of open
 * incidents are measured to `now`, not taken from the answer, so they keep
 * counting between polls.
 */
export function historyView(
  view: IncidentsView | null,
  modules: ModuleView[],
  now: Date,
  tr: Translator,
): HistoryVM {
  const incidents = view?.incidents ?? [];
  const t = now.getTime();
  const today = startOfDay(t);
  const covered = view ? Date.parse(view.coveredSince) : t;
  const names = new Map(modules.map((m) => [m.id, m.name]));

  const days: DayCell[] = [];
  for (let back = 6; back >= 0; back--) {
    const from = startOfDay(today - back * DAY + DAY / 2);
    const to = startOfDay(from + DAY * 1.5);
    const label =
      from === today
        ? tr.t('history.today')
        : new Date(from).toLocaleDateString(tr.locale, { weekday: 'short' });
    const long = dayLabel(from, today, tr);
    const touching = incidents.filter((i) => touches(i, from, to, t));
    const unwatched = to <= covered;
    const tone: Tone = unwatched
      ? 'muted'
      : touching.some((i) => i.severity === 'critical')
        ? 'critical'
        : touching.length
          ? 'warning'
          : 'ok';
    const title = unwatched
      ? tr.t('history.dayUnknown', { day: long })
      : touching.length
        ? tr.n('history.dayIssues', touching.length, { day: long })
        : tr.t('history.dayNone', { day: long });
    days.push({
      key: from,
      label: label.replace(/\.$/, ''),
      tone,
      count: touching.length,
      title,
      today: from === today,
    });
  }

  const rows = incidents.map((i) => {
    const start = Date.parse(i.start);
    const open = i.end === null;
    const row: IncidentRow = {
      id: i.id,
      title: i.title,
      tone: i.severity,
      icon: i.severity === 'critical' ? 'alert-circle' : 'warning',
      meta: [names.get(i.module) ?? i.module, clockTime(start, tr.lang)].join(', '),
      duration: open
        ? tr.t('history.stillOpen', { span: span(t - start, tr.lang) })
        : span(i.durationMs, tr.lang),
      open,
      silenced: i.silenced,
    };
    return { row, day: startOfDay(start) };
  });

  const windowStart = startOfDay(today - 6 * DAY + DAY / 2);
  return {
    days,
    groups: byDay(rows, today, tr),
    preview: byDay(rows.slice(0, HISTORY_PREVIEW), today, tr),
    total: incidents.length,
    summary: incidents.length ? tr.n('history.total', incidents.length) : tr.t('history.none'),
    coveredNote:
      view && covered > windowStart
        ? tr.t('history.coveredSince', { when: dateTime(view.coveredSince, tr.lang) })
        : null,
  };
}
