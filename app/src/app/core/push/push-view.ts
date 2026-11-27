import { DEADMAN_GRACE_MINUTES } from '@kubernanny/protocol';

import { Translator } from '../../i18n/translator';
import { AgentPushView } from '../agent.model';
import { NativePushStatus } from './push-native';

export interface PushVM {
  /** Shown at all: in a build that can push, for a real cluster whose agent answered, or to switch off a stored sign. */
  visible: boolean;
  /** The agent answered, so on, off, locked and no relay are its word (false while only a stored sign is shown). */
  known: boolean;
  /** Switched off in the deployment: a lock, no button (like a locked module). */
  locked: boolean;
  note: string;
  action: 'enable' | 'disable' | null;
  actionLabel: string;
  canTest: boolean;
  /**
   * The optional sign before each push, under "Advanced": while push is on for this device, and
   * whenever a sign is stored on it, whatever the agent says (the phone puts it before every push it
   * opens, so it must always be possible to switch it off).
   */
  sign: SignVM | null;
  /** "Warn when the agent goes silent"; only while push is on for this device. */
  deadman: DeadmanVM | null;
}

/**
 * "Identification sign before each push" (push-marker.ts, docs/NOTIFICATIONS.md,
 * "Is this push real?"). Off by default; on exactly when this device keeps a
 * sign, which is also what the iOS extension and the Android service read.
 */
export interface SignVM {
  on: boolean;
  /** On: "Your sign: 🦉🌵🔑. …"; off: what off means. */
  line: string;
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

const HIDDEN: PushVM = {
  visible: false,
  known: false,
  locked: false,
  note: '',
  action: null,
  actionLabel: '',
  canTest: false,
  sign: null,
  deadman: null,
};

/** The dead man's switch row of a device with push on (docs/NOTIFICATIONS.md, "When the agent goes silent"). */
export function deadmanView(agent: AgentPushView, tr: Translator, fallbackGrace = 15): DeadmanVM {
  const graces = DEADMAN_GRACE_MINUTES.map((minutes) => ({
    minutes,
    label: tr.t('push.deadmanMinutes', { n: minutes }),
  }));
  const d = agent.deadman;
  if (d.state === 'locked') {
    return {
      editable: false,
      on: false,
      grace: fallbackGrace,
      graces,
      note: tr.t('push.deadmanLocked'),
    };
  }
  const on = d.grace !== null;
  return {
    editable: true,
    on,
    grace: d.grace ?? fallbackGrace,
    graces,
    note: tr.t(d.state === 'relay' ? 'push.deadmanRelay' : 'push.deadmanHint'),
  };
}

/**
 * The "Push to this device" section. The agent's answer is the truth about
 * the registration: when it forgot the token (FCM dropped it, the deployment
 * switched push off and back on) the button offers to turn push on again.
 */
export function pushView(
  input: {
    demo: boolean;
    native: NativePushStatus | null;
    agent: AgentPushView | null;
    marker?: string | null;
  },
  tr: Translator,
): PushVM {
  const { demo, native, agent, marker } = input;
  if (demo || !native?.available) {
    return HIDDEN;
  }
  // A sign this device keeps: offered to switch off in every state below, not only with push on.
  const stored: SignVM | null = marker
    ? { on: true, line: tr.t('push.markerOn', { marker }) }
    : null;
  if (!agent) {
    // The agent did not answer (out of reach, or before native push): only the stored sign, if any.
    return stored ? { ...HIDDEN, visible: true, note: tr.t('push.unknown'), sign: stored } : HIDDEN;
  }
  if (agent.state === 'locked') {
    return {
      ...HIDDEN,
      visible: true,
      known: true,
      locked: true,
      note: tr.t('push.locked'),
      sign: stored,
    };
  }
  if (agent.state === 'no-relay') {
    return { ...HIDDEN, visible: true, known: true, note: tr.t('push.noRelay'), sign: stored };
  }
  if (agent.registered) {
    return {
      visible: true,
      known: true,
      locked: false,
      note: tr.t(agent.relay ? 'push.on' : 'push.relayNotNow'),
      action: 'disable',
      actionLabel: tr.t('push.disable'),
      canTest: agent.relay,
      sign: {
        on: !!marker,
        line: marker ? tr.t('push.markerOn', { marker }) : tr.t('push.markerOff'),
      },
      deadman: deadmanView(agent, tr),
    };
  }
  return {
    ...HIDDEN,
    visible: true,
    known: true,
    note: tr.t('push.hint'),
    action: 'enable',
    actionLabel: tr.t('push.enable'),
    sign: stored,
  };
}
