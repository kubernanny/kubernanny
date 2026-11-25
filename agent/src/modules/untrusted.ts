/**
 * Reading answers of in-cluster HTTP services (Prometheus, Alertmanager,
 * Grafana, Loki, Gatus, …). Anything that can run a pod can answer in their
 * place, so nothing in such an answer is trusted to have the type its API
 * documents: every field goes through one of these before it reaches an
 * issue, a stat or a log line, and every list is cut to a size.
 */
import { Issue, IssueSeverity } from '../checks/types';
import { isText, t } from '../i18n/text';
import { CONTROL_CHARS } from '../util/log-safe';
import type { Stat } from './types';

/** Longest string kept from an untrusted answer (names, states, messages). */
export const MAX_FIELD = 300;
/** Issues one untrusted integration may report; the rest become one summary issue. */
export const MAX_ISSUES_PER_MODULE = 50;


/** A string (or a finite number as one), without control characters, cut to `max`; anything else is undefined. */
export function str(value: unknown, max = MAX_FIELD): string | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value);
  }
  if (typeof value !== 'string') {
    return undefined;
  }
  const clean = value.replace(CONTROL_CHARS, ' ');
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

/** A finite number, or undefined. Numeric strings count (Prometheus sends values as strings). */
export function num(value: unknown): number | undefined {
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  return typeof n === 'number' && Number.isFinite(n) ? n : undefined;
}

/** The array, cut to `max` entries, or an empty one. */
export function list(value: unknown, max: number): unknown[] {
  return Array.isArray(value) ? value.slice(0, max) : [];
}

/** A plain object, or an empty one. */
export function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/** A string map (labels, annotations): string values only, at most `max` keys. */
export function strings(value: unknown, max = 64): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(record(value)).slice(0, max)) {
    const s = str(v);
    const key = str(k, 100);
    if (s !== undefined && key !== undefined) {
      out[key] = s;
    }
  }
  return out;
}

const RANK: Record<IssueSeverity, number> = { critical: 0, warning: 1, info: 2 };

/**
 * At most `max` issues, the most severe first; the rest are counted in one
 * issue of their worst severity, so an answer with thousands of alerts can
 * neither flood the app nor push a response past its size limit.
 */
export function capIssues(issues: Issue[], moduleId: string, max = MAX_ISSUES_PER_MODULE): Issue[] {
  if (issues.length <= max) {
    return issues;
  }
  const sorted = [...issues].sort((a, b) => RANK[a.severity] - RANK[b.severity]);
  const kept = sorted.slice(0, max - 1);
  const rest = sorted.slice(max - 1);
  return [
    ...kept,
    {
      id: `${moduleId}/more`,
      check: moduleId,
      severity: rest[0]!.severity,
      title: t('module.moreIssues.title', { n: rest.length }),
      cause: t('module.moreIssues.cause'),
      actions: [],
    },
  ];
}

/** A stat value that is neither a string nor a Text (an object from a forged answer) becomes "?". */
export function boundStats(stats: Stat[]): Stat[] {
  return stats.slice(0, 20).map((s) => (typeof s.value === 'string' ? { ...s, value: str(s.value, 80) ?? '?' } : isText(s.value) ? s : { ...s, value: '?' }));
}
