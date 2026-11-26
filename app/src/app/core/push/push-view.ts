import { DEADMAN_GRACE_MINUTES } from '@kubernanny/protocol';
import { AgentPushView } from '../agent.model';
import { NativePushStatus } from './push-native';
import { Translator } from '../../i18n/translator';

export interface PushVM {
  /** Shown at all: only in a build that can push, for a real cluster whose agent answered. */
  visible: boolean;
  /** Switched off in the deployment: a lock, no button (like a locked module). */
  locked: boolean;
  note: string;
  action: 'enable' | 'disable' | null;
  actionLabel: string;
  canTest: boolean;
  /** While push is on: the person's authenticity marker, or a nudge to choose one (push-marker.ts). */
  markerLine: string;
  /** "Change sign" / "Choose a sign"; empty when there is nothing to change. */
  markerActionLabel: string;
  /** "Warn when the agent goes silent"; only while push is on for this device. */
  deadman: DeadmanVM | null;
}

export interface DeadmanVM {
  /** The switch can be used (an agent and deployment that support it). */
  editable: boolean;
  on: boolean;
  /** The grace shown as chosen (the device's, or the default while off). */
  grace: number;
  graces: { minutes: number; label: string }[];
  /** One line: what it does, or why it cannot be used here. */
  note: string;
}

const HIDDEN: PushVM = { visible: false, locked: false, note: '', action: null, actionLabel: '', canTest: false, markerLine: '', markerActionLabel: '', deadman: null };

/** The dead man's switch row of a device with push on (docs/NOTIFICATIONS.md, "When the agent goes silent"). */
export function deadmanView(agent: AgentPushView, tr: Translator, fallbackGrace = 15): DeadmanVM {
  const graces = DEADMAN_GRACE_MINUTES.map((minutes) => ({ minutes, label: tr.t('push.deadmanMinutes', { n: minutes }) }));
  const d = agent.deadman;
  if (d.state === 'locked') {
    return { editable: false, on: false, grace: fallbackGrace, graces, note: tr.t('push.deadmanLocked') };
  }
  const on = d.grace !== null;
  return { editable: true, on, grace: d.grace ?? fallbackGrace, graces, note: tr.t(d.state === 'relay' ? 'push.deadmanRelay' : 'push.deadmanHint') };
}

/**
 * The "Push to this device" section. The agent's answer is the truth about
 * the registration: when it forgot the token (FCM dropped it, the deployment
 * switched push off and back on) the button offers to turn push on again.
 */
export function pushView(input: { demo: boolean; native: NativePushStatus | null; agent: AgentPushView | null; marker?: string | null }, tr: Translator): PushVM {
  const { demo, native, agent, marker } = input;
  if (demo || !native?.available || !agent) {
    return HIDDEN;
  }
  if (agent.state === 'locked') {
    return { ...HIDDEN, visible: true, locked: true, note: tr.t('push.locked') };
  }
  if (agent.state === 'no-relay') {
    return { ...HIDDEN, visible: true, note: tr.t('push.noRelay') };
  }
  if (agent.registered) {
    return {
      visible: true,
      locked: false,
      note: tr.t(agent.relay ? 'push.on' : 'push.relayNotNow'),
      action: 'disable',
      actionLabel: tr.t('push.disable'),
      canTest: agent.relay,
      markerLine: marker ? tr.t('push.markerOn', { marker }) : tr.t('push.markerMissing'),
      markerActionLabel: tr.t(marker ? 'push.markerChange' : 'push.markerChoose'),
      deadman: deadmanView(agent, tr),
    };
  }
  return { ...HIDDEN, visible: true, note: tr.t('push.hint'), action: 'enable', actionLabel: tr.t('push.enable') };
}
