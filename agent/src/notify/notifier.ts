import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { CONFIG, Config } from '../config';
import { Lang, Text, render, t } from '../i18n/text';
import type { IssueView, Snapshot } from '../status/status.service';
import { IncidentsService } from '../incidents/incidents.service';
import { AppPushService } from '../push/app-push.service';
import { digestDue, formatDigest, weekKey } from './digest';
import { NotifiedStore } from './notified-store';

export interface NotifyPlan {
  opened: IssueView[];
  /** Issues pushed earlier that are gone now, with the title they had. */
  resolved: { id: string; title: Text }[];
  /** A pushed warning that turned critical. */
  escalated: IssueView[];
}

export interface Pushed {
  title: Text;
  severity: 'warning' | 'critical';
}

/**
 * What to push this run. An issue is pushed once it has lasted `afterMs`
 * (rollouts and kured reboots heal before that), again only if it turns
 * critical, and its end is pushed only if its start was.
 */
export function planNotifications(
  pushed: Map<string, Pushed>,
  issues: IssueView[],
  now: Date,
  afterMs: number,
): NotifyPlan {
  const plan: NotifyPlan = { opened: [], resolved: [], escalated: [] };
  // Hints are shown in the app, never pushed. A silenced issue sends nothing
  // new, but still counts as present: silencing is no reason to say "resolved".
  const pushable = issues.filter((i) => i.severity !== 'info');
  const current = new Set(pushable.map((i) => i.id));
  const relevant = pushable.filter((i) => !i.silencedUntil);
  for (const issue of relevant) {
    const before = pushed.get(issue.id);
    if (!before) {
      if (now.getTime() - Date.parse(issue.since) >= afterMs) {
        plan.opened.push(issue);
      }
    } else if (before.severity === 'warning' && issue.severity === 'critical') {
      plan.escalated.push(issue);
    }
  }
  for (const [id, p] of pushed) {
    if (!current.has(id)) {
      plan.resolved.push({ id, title: p.title });
    }
  }
  return plan;
}

export function formatPush(
  cluster: string,
  plan: NotifyPlan,
  detail: 'full' | 'minimal',
  lang: Lang,
): { title: string; body: string; priority: number; tags: string } | null {
  const bad = [...plan.escalated, ...plan.opened];
  if (bad.length === 0 && plan.resolved.length === 0) {
    return null;
  }
  const s = (text: Text) => render(text, lang);
  const critical = bad.some((i) => i.severity === 'critical');
  if (detail === 'minimal') {
    // Nothing about the cluster's contents: no namespaces, names, hosts or messages.
    const crit = bad.filter((i) => i.severity === 'critical').length;
    const parts = [
      crit ? t('push.minimal.critical', { n: crit }) : null,
      bad.length - crit ? t('push.minimal.warnings', { n: bad.length - crit }) : null,
      plan.resolved.length ? t('push.minimal.resolved', { n: plan.resolved.length }) : null,
    ].filter((p) => p !== null);
    return {
      title: s(bad.length === 0 ? t('push.minimal.titleResolved', { cluster }) : t('push.minimal.titleNew', { cluster })),
      body: s(t('push.minimal.body', { parts })),
      priority: critical ? 5 : bad.length > 0 ? 3 : 2,
      tags: critical ? 'rotating_light' : bad.length > 0 ? 'warning' : 'white_check_mark',
    };
  }
  const lines = [
    ...bad.map((i) => `${i.severity === 'critical' ? '🔴' : '🟡'} ${s(i.title)}: ${s(i.cause)}`),
    ...plan.resolved.map((r) => s(t('push.resolvedLine', { title: r.title }))),
  ];
  const title =
    bad.length === 0
      ? s(t('push.title.resolved', { cluster, n: plan.resolved.length }))
      : bad.length === 1
        ? `${cluster}: ${s(bad[0].title)}`
        : s(t('push.title.many', { cluster, n: bad.length }));
  return {
    title,
    body: lines.join('\n'),
    priority: critical ? 5 : bad.length > 0 ? 3 : 2,
    tags: critical ? 'rotating_light' : bad.length > 0 ? 'warning' : 'white_check_mark',
  };
}

/**
 * A change that could blind or lock out the owner if a stolen device made it
 * (docs/SECURITY.md, "A stolen device key"). Each one is announced through
 * every channel, even with notifications switched off in the app or during a
 * maintenance window; only `checks.disabled: [notifications]` in Helm silences them.
 */
export type SecurityEvent =
  | { kind: 'notificationsOff' }
  | { kind: 'moduleOff'; id: string }
  | { kind: 'actionOff'; id: string }
  | { kind: 'maintenance'; hours: number }
  | { kind: 'deviceRevoked'; device: string }
  | { kind: 'devicePaired' }
  | { kind: 'advisoryAccepted'; component: string; advisory: string; days: number };

const SECURITY_LINE: { [K in SecurityEvent['kind']]: (by: string, e: Extract<SecurityEvent, { kind: K }>) => Text } = {
  notificationsOff: (by) => t('push.security.notificationsOff', { by }),
  moduleOff: (by, e) => t('push.security.moduleOff', { by, id: e.id }),
  actionOff: (by, e) => t('push.security.actionOff', { by, id: e.id }),
  maintenance: (by, e) => t('push.security.maintenance', { by, hours: e.hours }),
  deviceRevoked: (by, e) => t('push.security.deviceRevoked', { by, device: e.device }),
  devicePaired: (by) => t('push.security.devicePaired', { by }),
  advisoryAccepted: (by, e) => t('push.security.advisoryAccepted', { by, advisory: e.advisory, component: e.component, days: e.days }),
};

/** One short message naming the device (`by`) and what it changed; `minimal` names neither. */
export function formatSecurityAlert(cluster: string, by: string, events: SecurityEvent[], detail: 'full' | 'minimal', lang: Lang): Push {
  const s = (text: Text) => render(text, lang);
  const lines =
    detail === 'minimal'
      ? [s(t('push.security.minimal'))]
      : events.map((e) => s((SECURITY_LINE[e.kind] as (by: string, e: SecurityEvent) => Text)(by, e)));
  return { title: s(t('push.security.title', { cluster })), body: [...lines, s(t('push.security.advice'))].join('\n'), priority: 4, tags: 'lock' };
}

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

type Push = NonNullable<ReturnType<typeof formatPush>>;

/** The body each chat service expects. */
export function webhookBody(format: WebhookFormat | 'json-minimal', cluster: string, push: Push, plan: NotifyPlan, lang: Lang): unknown {
  const s = (text: Text) => render(text, lang);
  switch (format) {
    case 'discord':
      return {
        username: 'Kubernanny',
        embeds: [{ title: push.title, description: push.body, color: push.priority >= 5 ? 0xff5c6c : push.priority >= 3 ? 0xf2b33d : 0x3dd9b4 }],
      };
    case 'slack':
      return { text: `*${push.title}*\n${push.body}` };
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

/** Pushes status changes to ntfy, a webhook (Discord, Slack, Gotify, JSON) and the app's native push. No-op without any. */
@Injectable()
export class Notifier {
  private readonly logger = new Logger(Notifier.name);
  private readonly pushed = new Map<string, Pushed>();
  private digestSentFor: string | null = null;
  /** The issues already pushed, read back from the ConfigMap once, before the first run plans anything. */
  private restored: Promise<void> | null = null;

  constructor(
    @Inject(CONFIG) private readonly config: Config,
    /** The episodes of the week; the run loop records them, whether notifications are on or not. */
    @Inject(IncidentsService) private readonly incidents: IncidentsService = new IncidentsService(),
    /** The "app" channel: native push to registered devices. Absent in tests that do not care. */
    @Optional() @Inject(AppPushService) private readonly appPush?: AppPushService,
    /** Keeps `pushed` across restarts (ConfigMap key `notified`). Absent in tests that do not care. */
    @Optional() @Inject(NotifiedStore) private readonly store?: NotifiedStore,
  ) {}

  get channels(): string[] {
    return [
      this.config.ntfyUrl ? 'ntfy' : null,
      this.config.webhookUrl ? detectFormat(this.config.webhookUrl, this.config.webhookFormat) : null,
      this.appPush?.hasTargets() ? 'app' : null,
    ].filter((c): c is string => c !== null);
  }

  /** Before the first plan: what an earlier run of the agent already sent counts as sent. */
  private restore(): Promise<void> {
    this.restored ??= (async () => {
      for (const [id, pushed] of (await this.store?.load()) ?? new Map<string, Pushed>()) {
        if (!this.pushed.has(id)) {
          this.pushed.set(id, pushed);
        }
      }
    })();
    return this.restored;
  }

  async update(snapshot: Snapshot, now: Date): Promise<void> {
    if (this.channels.length === 0) {
      return;
    }
    await this.restore();
    await this.maybeSendDigest(snapshot.cluster, now);
    const plan = planNotifications(this.pushed, snapshot.issues, now, this.config.notifyAfterSeconds * 1000);
    const push = formatPush(snapshot.cluster, plan, this.config.notifyDetail, this.config.language);
    if (!push) {
      return;
    }
    // Not marked as pushed unless a channel took it: the next run tries again.
    if (!(await this.deliver(snapshot.cluster, push, plan))) {
      return;
    }
    for (const i of [...plan.opened, ...plan.escalated]) {
      this.pushed.set(i.id, { title: i.title, severity: i.severity === 'critical' ? 'critical' : 'warning' });
    }
    for (const r of plan.resolved) {
      this.pushed.delete(r.id);
    }
    await this.store?.save(this.pushed);
  }

  /**
   * The weekly report (`DIGEST=weekly`): once per week, from DIGEST_HOUR on
   * DIGEST_WEEKDAY in the agent's time zone. Not before the agent has watched
   * for a day, so a restart never sends a near-empty report.
   */
  private async maybeSendDigest(cluster: string, now: Date): Promise<void> {
    const { digest } = this.config;
    if (!digest || !digestDue(now, digest.weekday, digest.hour) || now.getTime() - this.incidents.since < 86_400_000) {
      return;
    }
    const week = weekKey(now);
    if (this.digestSentFor === week) {
      return;
    }
    const push = formatDigest(cluster, this.incidents.lastWeek(now.getTime()), now.getTime(), this.incidents.since, this.config.notifyDetail, this.config.language);
    const delivered = await this.deliver(cluster, push, { opened: [], resolved: [], escalated: [] });
    if (delivered) {
      this.digestSentFor = week;
    }
  }

  /** Sends to every channel; true when at least one took it. */
  private async deliver(cluster: string, push: Push, plan: NotifyPlan): Promise<boolean> {
    const sends: Promise<void>[] = [];
    if (this.config.ntfyUrl) {
      sends.push(this.sendNtfy(this.config.ntfyUrl, push));
    }
    if (this.config.webhookUrl) {
      const format = detectFormat(this.config.webhookUrl, this.config.webhookFormat);
      const body = format === 'json' && this.config.notifyDetail === 'minimal' ? 'json-minimal' : format;
      sends.push(this.post(this.config.webhookUrl, webhookBody(body, cluster, push, plan, this.config.language)));
    }
    if (this.appPush?.hasTargets()) {
      sends.push(this.sendApp(this.appPush, push));
    }
    const results = await Promise.allSettled(sends);
    const failed = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    if (failed.length > 0) {
      this.logger.warn(`push failed: ${failed.map((f) => (f.reason instanceof Error ? f.reason.message : f.reason)).join('; ')}`);
    }
    return failed.length < results.length;
  }

  /**
   * Announces security-relevant changes (SecurityEvent) at once, past the
   * app's switch and any maintenance window. Callers await it before the
   * change takes effect where the change would stop it (notifications off).
   * Never throws: a channel that is down must not block the change itself.
   */
  async securityAlert(by: string, events: SecurityEvent[]): Promise<void> {
    if (events.length === 0 || this.config.disabledModules.includes('notifications') || this.channels.length === 0) {
      return;
    }
    const push = formatSecurityAlert(this.config.clusterName, by, events, this.config.notifyDetail, this.config.language);
    try {
      await this.deliver(this.config.clusterName, push, { opened: [], resolved: [], escalated: [] });
    } catch (err) {
      this.logger.warn(`security notification failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  /** Sends one test message through every channel, for the app's "test notification" button. */
  async test(cluster: string): Promise<string[]> {
    const lang = this.config.language;
    const push = { title: render(t('push.test.title', { cluster }), lang), body: render(t('push.test.body'), lang), priority: 3, tags: 'white_check_mark' };
    const plan = { opened: [], resolved: [], escalated: [] };
    const done: string[] = [];
    if (this.config.ntfyUrl) {
      await this.sendNtfy(this.config.ntfyUrl, push);
      done.push('ntfy');
    }
    if (this.config.webhookUrl) {
      const format = detectFormat(this.config.webhookUrl, this.config.webhookFormat);
      await this.post(this.config.webhookUrl, webhookBody(format, cluster, push, plan, lang));
      done.push(format);
    }
    if (this.appPush?.hasTargets()) {
      await this.sendApp(this.appPush, push);
      done.push('app');
    }
    return done;
  }

  /** The same title and body as every channel, `minimal` included; sealed per device by AppPushService. */
  private async sendApp(appPush: AppPushService, push: Push): Promise<void> {
    if (!(await appPush.deliver({ title: push.title, body: push.body, priority: push.priority }))) {
      throw new Error('app push reached no device');
    }
  }

  private async sendNtfy(url: string, push: Push): Promise<void> {
    const headers: Record<string, string> = {
      // HTTP headers are Latin-1; ntfy decodes RFC 2047 for the title.
      title: `=?UTF-8?B?${Buffer.from(push.title).toString('base64')}?=`,
      priority: String(push.priority),
      tags: push.tags,
    };
    if (this.config.publicUrl) {
      headers.click = this.config.publicUrl;
    }
    if (this.config.ntfyToken) {
      headers.authorization = `Bearer ${this.config.ntfyToken}`;
    }
    const res = await fetch(url, { method: 'POST', headers, body: push.body, redirect: 'error', signal: AbortSignal.timeout(10_000) });
    if (!res.ok) {
      throw new Error(`ntfy answered ${res.status}`);
    }
  }

  private async post(url: string, body: unknown): Promise<void> {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      // A redirect could send the message, or a token in the URL, somewhere else.
      redirect: 'error',
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      throw new Error(`webhook answered ${res.status}`);
    }
  }
}
