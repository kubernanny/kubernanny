import { raw, t, Text } from '../i18n/text';
/** Number formats for stats, shared by core checks and integrations. */
export const pct = (part: number, whole: number) => (whole > 0 ? Math.round((part / whole) * 100) : 0);

/** "13,9 GiB" / "13.9 GiB", "15 GiB" (no trailing zero): formatted per language when the Text is rendered. */
export function bytes(n: number): Text {
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return t('fmt.unit', { n: v >= 100 || i === 0 ? Math.round(v) : Math.round(v * 10) / 10, unit: units[i]! });
}

/** A decimal number in the reader's language, at most `digits` decimals, no trailing zeros ("6,1", "84,2"). */
export function decimal(n: number, digits = 1): Text {
  return t('fmt.number', { n: Math.round(n * 10 ** digits) / 10 ** digits });
}

/** A number with its unit, decimals per language: "6,1 ms". */
export function withUnit(n: number, unit: string, digits = 1): Text {
  return t('fmt.unit', { n: Math.round(n * 10 ** digits) / 10 ** digits, unit });
}

/**
 * A cron schedule in words for the common shapes (daily, weekly, hourly),
 * with 5 fields or 6 (seconds first, as CloudNativePG writes them); anything
 * else stays as written.
 */
export function cronText(expr: string): Text {
  const f = expr.trim().split(/\s+/);
  const [min, hour, dom, mon, dow] = f.length === 6 ? f.slice(1) : f.length === 5 ? f : [];
  const num = (v: string | undefined) => (v !== undefined && /^\d+$/.test(v) ? Number(v) : null);
  const m = num(min);
  const h = num(hour);
  if (m === null || dom !== '*' || mon !== '*') {
    return raw(expr);
  }
  const time = h === null ? '' : `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
  if (hour === '*' && dow === '*') {
    return t('cron.hourly', { minute: String(m) });
  }
  if (h === null) {
    return raw(expr);
  }
  if (dow === '*') {
    return t('cron.daily', { time });
  }
  const d = num(dow);
  return d === null ? raw(expr) : t('cron.weekly', { day: t('cron.day', { d }), time });
}
