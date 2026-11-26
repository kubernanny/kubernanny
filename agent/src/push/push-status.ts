import { PUSH_STATUS_PROBLEMS, PUSH_STATUS_TITLE, PushStatus } from '@kubernanny/protocol';

import { Lang, render } from '../i18n/text';
import type { Snapshot } from '../status/status.service';

/**
 * The cluster's state as it travels inside a native push (`w`,
 * docs/PROTOCOL.md "Push status"): the phone writes it into its home-screen
 * widget, so the widget is as fresh as the last push, not only as the last
 * time the app was open. Counted like the app's headline and its widget
 * (app/src/app/core/widget/widget-summary.ts): silenced issues and hints left
 * out, outages before warnings. With `detail: minimal` only the light and the
 * counts, like the message itself.
 */
export function pushStatus(snapshot: Snapshot, detail: 'full' | 'minimal', lang: Lang): PushStatus {
  const counted = snapshot.issues.filter((i) => !i.silencedUntil && i.severity !== 'info');
  const critical = counted.filter((i) => i.severity === 'critical');
  const warnings = counted.filter((i) => i.severity !== 'critical');
  const checked = snapshot.checkedAt ? Date.parse(snapshot.checkedAt) : NaN;
  const status: PushStatus = {
    l: snapshot.light,
    c: critical.length,
    n: warnings.length,
    a: Number.isFinite(checked) ? checked : null,
  };
  if (detail === 'full' && counted.length > 0) {
    status.i = [...critical, ...warnings]
      .slice(0, PUSH_STATUS_PROBLEMS)
      .map((i) => ({ s: i.severity === 'critical' ? 'c' : 'w', t: clip(render(i.title, lang)) }));
  }
  return status;
}

function clip(text: string): string {
  const chars = Array.from(text);
  return chars.length <= PUSH_STATUS_TITLE ? text : chars.slice(0, PUSH_STATUS_TITLE - 1).join('') + '…';
}
