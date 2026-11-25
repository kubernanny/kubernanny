import { Lang, Text, render } from '../i18n/text';
import type { NotifyPlan, Push } from './format';

export type WebhookFormat = 'discord' | 'slack' | 'gotify' | 'json';

export function detectFormat(url: string, configured: string | undefined): WebhookFormat {
  if (configured && configured !== 'auto') {
    return configured as WebhookFormat;
  }
  if (/discord(app)?\.com\/api\/webhooks/.test(url)) {
    return 'discord';
  }
  if (/hooks\.slack\.com/.test(url)) {
    return 'slack';
  }
  if (/\/message(\?|$)/.test(url)) {
    return 'gotify';
  }
  return 'json';
}

/**
 * Titles and causes carry the cluster's own words (an alert name, an Argo CD
 * message): whoever writes those must not reach a chat with a mention or a
 * link of their choosing. Slack: `<…>` is its only control syntax (mentions
 * like <!channel>, links like <url|text>), escaped as HTML entities.
 */
export function escapeSlack(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Discord: backslash before every markdown character (masked links, mentions, formatting). `allowed_mentions` is the second guard. */
export function escapeDiscord(text: string): string {
  return text.replace(/[\\*_~`|[\]()<>#@]/g, (c) => `\\${c}`);
}

/** The body each chat service expects. */
export function webhookBody(format: WebhookFormat | 'json-minimal', cluster: string, push: Push, plan: NotifyPlan, lang: Lang): unknown {
  const s = (text: Text) => render(text, lang);
  switch (format) {
    case 'discord':
      return {
        username: 'Kubernanny',
        allowed_mentions: { parse: [] },
        embeds: [{ title: escapeDiscord(push.title), description: escapeDiscord(push.body), color: push.priority >= 5 ? 0xff5c6c : push.priority >= 3 ? 0xf2b33d : 0x3dd9b4 }],
      };
    case 'slack':
      return { text: `*${escapeSlack(push.title)}*\n${escapeSlack(push.body)}` };
    case 'gotify':
      return { title: push.title, message: push.body, priority: push.priority * 2 };
    case 'json':
      return {
        cluster,
        title: push.title,
        body: push.body,
        priority: push.priority,
        opened: plan.opened.map(({ id, title, severity, cause }) => ({ id, title: s(title), severity, cause: s(cause) })),
        escalated: plan.escalated.map(({ id, title, severity, cause }) => ({ id, title: s(title), severity, cause: s(cause) })),
        resolved: plan.resolved.map(({ id, title }) => ({ id, title: s(title) })),
      };
    case 'json-minimal':
      return {
        cluster,
        title: push.title,
        body: push.body,
        priority: push.priority,
        counts: { opened: plan.opened.length, escalated: plan.escalated.length, resolved: plan.resolved.length },
      };
  }
}
