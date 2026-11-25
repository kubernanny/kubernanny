import { Snapshot } from '../core/agent.model';
import { clockTime } from '../core/format';
import { Translator } from '../i18n/translator';

export interface CountdownView {
  /** "Geprüft vor 12 s · nächste in 48 s"; without a schedule from the agent only the first half. */
  text: string;
  /** 0..1 of the way from the last check to the next; null without a schedule (older agents). */
  progress: number | null;
  /** For screen readers: what tapping does and when the next check is, as a clock time, so it does not change every second. */
  label: string;
}

/** "12 s", "4 min", "2 h": short spans for the countdown line. */
export function shortSpan(ms: number, tr: Translator): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) {
    return tr.t('countdown.seconds', { n: s });
  }
  const m = Math.round(s / 60);
  return m < 60 ? tr.t('countdown.minutes', { n: m }) : tr.t('countdown.hours', { n: Math.round(m / 60) });
}

/**
 * Since the last check and until the next one, for the line under the
 * headline and the ring around the eye. With reduced motion the caller ticks
 * every 5 s, and the progress moves in the same steps.
 */
export function countdownView(s: Pick<Snapshot, 'checkedAt' | 'nextCheckAt'> | null, now: number, tr: Translator, step = 1000): CountdownView | null {
  const checked = Date.parse(s?.checkedAt ?? '');
  if (!Number.isFinite(checked)) {
    return null;
  }
  const ago = tr.t('countdown.checked', { span: shortSpan(now - checked, tr) });
  const next = Date.parse(s?.nextCheckAt ?? '');
  if (!Number.isFinite(next) || next <= checked) {
    return { text: ago, progress: null, label: tr.t('countdown.labelNoSchedule') };
  }
  const left = next - now;
  const total = next - checked;
  const raw = Math.min(1, Math.max(0, (now - checked) / total));
  const progress = step > 1000 ? Math.min(1, Math.floor((now - checked) / step) * step / total) : raw;
  return {
    text: `${ago} · ${left > 1000 ? tr.t('countdown.next', { span: shortSpan(left, tr) }) : tr.t('countdown.due')}`,
    progress,
    label: tr.t('countdown.label', { time: clockTime(next, tr.lang) }),
  };
}
