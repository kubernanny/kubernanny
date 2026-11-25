/**
 * Control characters (C0, C1) and the bidi overrides. A line break inside an
 * issue id built from an Alertmanager alert name would otherwise start a
 * forged line in the audit log; an override would reorder what a reader sees.
 */
// eslint-disable-next-line no-control-regex
export const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f‪-‮⁦-⁩]/g;

/** A value from outside input as it may appear in a log line: no control characters, at most `max` characters. */
export function logSafe(value: unknown, max = 300): string {
  const text = String(value).replace(CONTROL_CHARS, '?');
  return text.length > max ? `${text.slice(0, max)}…` : text;
}
