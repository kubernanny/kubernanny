import { ClusterConfig } from '../core/agent.model';
import { PushVM } from '../core/push/push-view';
import { WIDGET_STALE_HOURS } from '../core/widget/widget-summary';
import { Translator } from '../i18n/translator';

/**
 * Whether push keeps this cluster's widget entry fresh on this device.
 * on / off as the push section shows it (the agent's answer is the truth);
 * unavailable when push cannot be had here (locked, no relay); unknown when
 * the push section is hidden (a build without push, the agent out of reach),
 * where a push key kept for the cluster still counts as on.
 */
export type WidgetPushState = 'on' | 'off' | 'unavailable' | 'unknown';

export interface WidgetVM {
  /** When the widget updates and what grey means, one short line each. */
  lines: string[];
  push: WidgetPushState;
  /** "Push is on for this device: …"; empty for unknown. */
  pushLine: string;
  /** Push is off and can be switched on here: the button to the push section. */
  offerPush: boolean;
}

export function widgetPushState(push: PushVM | null, cluster: ClusterConfig): WidgetPushState {
  if (push?.visible) {
    if (push.action === 'disable') {
      return 'on';
    }
    return push.action === 'enable' ? 'off' : 'unavailable';
  }
  return cluster.push ? 'on' : 'unknown';
}

/** The widget section's explanation (docs/NOTIFICATIONS.md, "The home-screen widget"). */
export function widgetView(input: { cluster: ClusterConfig; push: PushVM | null }, tr: Translator): WidgetVM {
  const push = widgetPushState(input.push, input.cluster);
  const pushLine = push === 'unknown' ? '' : tr.t(push === 'on' ? 'widget.pushOn' : push === 'off' ? 'widget.pushOff' : 'widget.pushUnavailable');
  return {
    lines: [tr.t('widget.updates'), tr.t('widget.quiet'), tr.t('widget.stale', { hours: WIDGET_STALE_HOURS }), tr.t('widget.silent')],
    push,
    pushLine,
    offerPush: push === 'off',
  };
}
