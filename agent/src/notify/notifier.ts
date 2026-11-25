import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { CONFIG, Config } from '../config';
import { render, t } from '../i18n/text';
import type { Snapshot } from '../status/status.service';
import { IncidentsService } from '../incidents/incidents.service';
import { AppPushService } from '../push/app-push.service';
import { digestDue, formatDigest, weekKey } from './digest';
import { NotifyPlan, Push, Pushed, SecurityEvent, formatPush, formatSecurityAlert, planNotifications } from './format';
import { NotifiedStore } from './notified-store';
import { detectFormat, webhookBody } from './webhook';

// Formatting and the webhook dialects live in format.ts and webhook.ts; existing imports keep working through here.
export * from './format';
export * from './webhook';

const EMPTY_PLAN: NotifyPlan = { opened: [], resolved: [], escalated: [] };

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

  /** `checks.disabled: [notifications]`: no channel at all, so nothing is ever sent (issues, security alerts, digest, test). */
  get locked(): boolean {
    return this.config.disabledModules?.includes('notifications') ?? false;
  }

  get channels(): string[] {
    if (this.locked) {
      return [];
    }
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
    const delivered = await this.deliver(cluster, push, EMPTY_PLAN);
    if (delivered) {
      this.digestSentFor = week;
    }
  }

  /** One send per configured channel, named; none when locked. */
  private sends(cluster: string, push: Push, plan: NotifyPlan): { channel: string; send: () => Promise<void> }[] {
    if (this.locked) {
      return [];
    }
    const out: { channel: string; send: () => Promise<void> }[] = [];
    const { ntfyUrl, webhookUrl } = this.config;
    if (ntfyUrl) {
      out.push({ channel: 'ntfy', send: () => this.sendNtfy(ntfyUrl, push) });
    }
    if (webhookUrl) {
      const format = detectFormat(webhookUrl, this.config.webhookFormat);
      const body = format === 'json' && this.config.notifyDetail === 'minimal' ? 'json-minimal' : format;
      out.push({ channel: format, send: () => this.post(webhookUrl, webhookBody(body, cluster, push, plan, this.config.language)) });
    }
    const appPush = this.appPush;
    if (appPush?.hasTargets()) {
      out.push({ channel: 'app', send: () => this.sendApp(appPush, push) });
    }
    return out;
  }

  /** Sends to every channel at once; the channels that took it. */
  private async sendAll(cluster: string, push: Push, plan: NotifyPlan): Promise<{ done: string[]; failed: string[] }> {
    const sends = this.sends(cluster, push, plan);
    const results = await Promise.allSettled(sends.map((s) => s.send()));
    const done: string[] = [];
    const failed: string[] = [];
    results.forEach((r, i) => {
      if (r.status === 'fulfilled') {
        done.push(sends[i]!.channel);
      } else {
        failed.push(`${sends[i]!.channel}: ${r.reason instanceof Error ? r.reason.message : String(r.reason)}`);
      }
    });
    if (failed.length > 0) {
      this.logger.warn(`push failed: ${failed.join('; ')}`);
    }
    return { done, failed };
  }

  /** Sends to every channel; true when at least one took it. */
  private async deliver(cluster: string, push: Push, plan: NotifyPlan): Promise<boolean> {
    return (await this.sendAll(cluster, push, plan)).done.length > 0;
  }

  /**
   * Announces security-relevant changes (SecurityEvent) at once, past the
   * app's switch and any maintenance window. Callers await it before the
   * change takes effect where the change would stop it (notifications off).
   * Never throws: a channel that is down must not block the change itself.
   */
  async securityAlert(by: string, events: SecurityEvent[]): Promise<void> {
    if (events.length === 0 || this.channels.length === 0) {
      return;
    }
    const push = formatSecurityAlert(this.config.clusterName, by, events, this.config.notifyDetail, this.config.language);
    try {
      await this.deliver(this.config.clusterName, push, EMPTY_PLAN);
    } catch (err) {
      this.logger.warn(`security notification failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  /**
   * Sends one test message through every channel, for the app's "test
   * notification" button. Throws when any channel failed, naming it, so a
   * broken webhook shows up there. Nothing when locked (the route refuses first).
   */
  async test(cluster: string): Promise<string[]> {
    const lang = this.config.language;
    const push = { title: render(t('push.test.title', { cluster }), lang), body: render(t('push.test.body'), lang), priority: 3, tags: 'white_check_mark' };
    const { done, failed } = await this.sendAll(cluster, push, EMPTY_PLAN);
    if (failed.length > 0) {
      throw new Error(failed.join('; '));
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
