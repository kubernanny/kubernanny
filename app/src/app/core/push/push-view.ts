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
}

const HIDDEN: PushVM = { visible: false, locked: false, note: '', action: null, actionLabel: '', canTest: false };

/**
 * The "Push to this device" section. The agent's answer is the truth about
 * the registration: when it forgot the token (FCM dropped it, the deployment
 * switched push off and back on) the button offers to turn push on again.
 */
export function pushView(input: { demo: boolean; native: NativePushStatus | null; agent: AgentPushView | null }, tr: Translator): PushVM {
  const { demo, native, agent } = input;
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
    return { visible: true, locked: false, note: tr.t(agent.relay ? 'push.on' : 'push.relayNotNow'), action: 'disable', actionLabel: tr.t('push.disable'), canTest: agent.relay };
  }
  return { visible: true, locked: false, note: tr.t('push.hint'), action: 'enable', actionLabel: tr.t('push.enable'), canTest: false };
}
