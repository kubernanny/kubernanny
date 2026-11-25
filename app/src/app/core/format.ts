import { CheckStatus, Light, Tone, Unit } from './agent.model';
import { LOCALE, Lang } from '../i18n/lang';

/*
 * Numbers, sizes and times for display. Pure functions with the language as
 * a parameter: the words they need are few and grammatical (German "vor 3
 * Tagen" but "3 Tage"), so they live here instead of in the dictionaries.
 */

/** Shown where a value is unknown. */
export const NO_VALUE = '–';

/** A number with exactly `digits` decimals, without thousands separators ("1,5" / "1.5"). */
export function decimal(v: number, lang: Lang, digits: number): string {
  return new Intl.NumberFormat(LOCALE[lang], { minimumFractionDigits: digits, maximumFractionDigits: digits, useGrouping: false }).format(v);
}

export function bytes(n: number | null | undefined, lang: Lang, digits = 1): string {
  if (n === null || n === undefined || !Number.isFinite(n)) {
    return NO_VALUE;
  }
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 100 || i === 0 ? Math.round(v) : decimal(v, lang, digits)} ${units[i]}`;
}

export function cores(milli: number | null | undefined, lang: Lang): string {
  if (milli === null || milli === undefined) {
    return NO_VALUE;
  }
  if (milli < 1000) {
    return `${Math.round(milli)}m`;
  }
  const value = milli / 1000;
  return Number.isInteger(value) ? String(value) : decimal(value, lang, value < 10 ? 2 : 1);
}

/** "42 %" in German, "42%" in English. */
export function percent(ratio: number | null | undefined, lang: Lang): string {
  if (ratio === null || ratio === undefined || !Number.isFinite(ratio)) {
    return NO_VALUE;
  }
  const n = Math.round(ratio * 100);
  return lang === 'de' ? `${n} %` : `${n}%`;
}

export function ratio(part: number | null | undefined, whole: number | null | undefined): number | null {
  return part === null || part === undefined || !whole ? null : part / whole;
}

/** "5 min", "3 h", "2 Tagen" / "2 days" (the German form follows "vor" and "seit"); null under a minute. */
export function duration(iso: string | null | undefined, now: Date, lang: Lang): string | null {
  if (!iso) {
    return null;
  }
  const seconds = Math.max(0, Math.round((now.getTime() - Date.parse(iso)) / 1000));
  if (seconds < 60) {
    return null;
  }
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) {
    return `${minutes} min`;
  }
  const hours = Math.round(minutes / 60);
  if (hours < 48) {
    return `${hours} h`;
  }
  const days = Math.round(hours / 24);
  return lang === 'de' ? `${days} Tagen` : `${days} days`;
}

/** "vor 5 min" / "5 min ago". */
export function relativeTime(iso: string | null | undefined, now: Date, lang: Lang): string {
  if (!iso) {
    return lang === 'de' ? 'noch nie' : 'never';
  }
  const d = duration(iso, now, lang);
  if (!d) {
    return lang === 'de' ? 'gerade eben' : 'just now';
  }
  return lang === 'de' ? `vor ${d}` : `${d} ago`;
}

/** "18:30", "Fr., 08:00" / "6:30 PM", "Fri, 8:00 AM": when something ends, with the weekday once it is another day. */
export function endTime(iso: string, now: Date, lang: Lang): string {
  const end = new Date(iso);
  const locale = LOCALE[lang];
  const time = end.toLocaleTimeString(locale, { hour: lang === 'de' ? '2-digit' : 'numeric', minute: '2-digit' });
  return end.toDateString() === now.toDateString() ? time : `${end.toLocaleDateString(locale, { weekday: 'short' })}, ${time}`;
}

/** "stumm bis 18:30", "stumm bis Fr., 08:00" / "silenced until 6:30 PM", "silenced until Fri, 8:00 AM": when a silence ends. */
export function untilText(iso: string, now: Date, lang: Lang): string {
  const when = endTime(iso, now, lang);
  return lang === 'de' ? `stumm bis ${when}` : `silenced until ${when}`;
}

/** "seit 3 h" / "for 3 h": how long an issue has been open. */
export function sinceText(iso: string, now: Date, lang: Lang): string {
  const d = duration(iso, now, lang);
  if (!d) {
    return lang === 'de' ? 'gerade neu' : 'just now';
  }
  return lang === 'de' ? `seit ${d}` : `for ${d}`;
}

/** Hours of the day in the active locale: "14:05" / "2:05 PM". */
export function clockTime(ms: number, lang: Lang): string {
  return new Date(ms).toLocaleTimeString(LOCALE[lang], { hour: lang === 'de' ? '2-digit' : 'numeric', minute: '2-digit' });
}

/** "seit 3 Tagen", "seit 8 Monaten" / "for 3 days", "for 8 months": how long a node or workload has existed. */
export function age(iso: string | undefined, now: Date, lang: Lang): string {
  if (!iso) {
    return NO_VALUE;
  }
  const days = Math.floor((now.getTime() - Date.parse(iso)) / 86_400_000);
  const de = lang === 'de';
  if (days < 1) {
    return de ? 'seit heute' : 'since today';
  }
  if (days < 60) {
    return de ? `seit ${days} ${days === 1 ? 'Tag' : 'Tagen'}` : `for ${days} ${days === 1 ? 'day' : 'days'}`;
  }
  const months = Math.round(days / 30);
  if (months < 24) {
    return de ? `seit ${months} Monaten` : `for ${months} months`;
  }
  const years = Math.round(days / 365);
  return de ? `seit ${years} Jahren` : `for ${years} years`;
}

/** How long something lasted: "45 s", "12 min", "2 h 14 min", "3 Tage 4 h" / "3 days 4 h". */
export function span(ms: number, lang: Lang): string {
  const minutes = Math.floor(Math.max(0, ms) / 60_000);
  if (minutes < 1) {
    return `${Math.max(0, Math.round(ms / 1000))} s`;
  }
  if (minutes < 60) {
    return `${minutes} min`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    const rest = minutes % 60;
    return rest ? `${hours} h ${rest} min` : `${hours} h`;
  }
  const days = Math.floor(hours / 24);
  const unit = lang === 'de' ? (days === 1 ? 'Tag' : 'Tage') : days === 1 ? 'day' : 'days';
  const rest = hours % 24;
  return rest ? `${days} ${unit} ${rest} h` : `${days} ${unit}`;
}

/** "Mo., 23.11., 14:05" / "Mon, 11/23, 2:05 PM": a moment within the last weeks. */
export function dateTime(iso: string, lang: Lang): string {
  return new Date(iso).toLocaleString(LOCALE[lang], {
    weekday: 'short',
    day: 'numeric',
    month: 'numeric',
    hour: lang === 'de' ? '2-digit' : 'numeric',
    minute: '2-digit',
  });
}

/** Midnight (local time) of the day `ms` falls on. */
export function startOfDay(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export function formatValue(v: number, unit: Unit, lang: Lang): string {
  switch (unit) {
    case 'ratio':
      return percent(v, lang);
    case 'bytesPerSecond':
      return `${bytes(v, lang)}/s`;
    case 'seconds':
      return v < 1 ? `${decimal(v * 1000, lang, v < 0.01 ? 1 : 0)} ms` : `${decimal(v, lang, 2)} s`;
    case 'count':
      // Restarts and the like are whole numbers; a rate below one keeps one decimal, "0" stays "0".
      return Number.isInteger(v) || v >= 10 || v === 0 ? String(Math.round(v)) : decimal(v, lang, 1);
  }
}

export const STATUS_TONE: Record<CheckStatus, Tone> = {
  ok: 'ok',
  warning: 'warning',
  critical: 'critical',
  error: 'muted',
  skipped: 'muted',
};

export const LIGHT_TONE: Record<Light, Tone> = { green: 'ok', yellow: 'warning', red: 'critical', unknown: 'muted' };
