import { BadRequestException, Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import type { Principal } from '../auth/devices.service';
import { CONFIG, Config } from '../config';
import { t } from '../i18n/text';
import { KubeClient, KubeError } from '../kube/kube-client';
import { IssueSeverity } from '../checks/types';
import { Notifier, SecurityEvent } from '../notify/notifier';
import { logSafe } from '../util/log-safe';
import { SETTINGS_CONFIGMAP } from '../settings/settings.service';
import { Serial } from '../util/serial';
import { upsertConfigMapData } from '../kube/configmap';

/** The durations the app offers; anything else is refused, so nobody silences an issue for a year by accident. */
export const SILENCE_HOURS = [1, 8, 24, 168] as const;
/** A maintenance window: no notifications at all, for planned work on the cluster. */
export const MAINTENANCE_HOURS = [1, 2, 4, 8, 24] as const;
const MAX_SILENCED = 500;
/** Silencing this many issues within BULK_WINDOW_MS is announced, whatever their severity: a quiet way to blind the owner otherwise. */
export const BULK_SILENCES = 4;
export const BULK_WINDOW_MS = 10 * 60_000;
/** Stored next to the silenced issues; no issue id is a lone asterisk. */
const MAINTENANCE = '*';

/**
 * Issues someone silenced for a while (a maintenance window, a known slow
 * backup). A silenced issue stays visible, but costs no light, no score and
 * sends no notification until it expires. Kept under the key `silenced` of
 * the ConfigMap `kubernanny-settings`, next to the switches, so it survives
 * restarts.
 */
@Injectable()
export class SilenceService implements OnModuleInit {
  private readonly audit = new Logger('audit');
  private until = new Map<string, number>();
  /** When the last silences were set, for the bulk announcement. */
  private recent: number[] = [];
  private bulkAnnouncedAt = -Infinity;
  /** Every change reads, changes and writes the whole map: one at a time, or two at once lose one. */
  private readonly writes = new Serial();

  constructor(
    @Inject(CONFIG) private readonly config: Config,
    @Inject(KubeClient) private readonly kube: KubeClient,
    /** Announces maintenance windows; absent in unit tests that do not care. */
    @Inject(Notifier) private readonly notifier?: Notifier,
  ) {}

  private get path(): string {
    return `/api/v1/namespaces/${encodeURIComponent(this.config.namespace)}/configmaps`;
  }

  async onModuleInit(): Promise<void> {
    try {
      const cm = await this.kube.get<{ data?: { silenced?: string } }>(`${this.path}/${SETTINGS_CONFIGMAP}`);
      const raw = JSON.parse(cm.data?.silenced ?? '{}') as Record<string, unknown>;
      this.until = new Map(Object.entries(raw).filter((e): e is [string, number] => typeof e[1] === 'number'));
    } catch (err) {
      if (!(err instanceof KubeError && err.status === 404)) {
        new Logger(SilenceService.name).warn(`cannot read silenced issues (${err instanceof Error ? err.message : err}); silences last until restart`);
      }
    }
  }

  /** When the issue's silence ends, or null when it is not silenced (expired ones count as not silenced). */
  silencedUntil(issueId: string, now = Date.now()): string | null {
    const until = this.until.get(issueId);
    return until !== undefined && until > now ? new Date(until).toISOString() : null;
  }

  /** When the maintenance window ends, or null outside one. */
  maintenanceUntil(now = Date.now()): string | null {
    return this.silencedUntil(MAINTENANCE, now);
  }

  /**
   * Starts (or moves the end of) a maintenance window. The checks keep running
   * and the app stays honest; only notifications wait. Whatever is still
   * broken when the window ends is sent then, as if it had just lasted long
   * enough. Announced through the channels first, since the window then holds back everything else.
   */
  startMaintenance(hours: number, who: Principal, now = Date.now()): Promise<string> {
    return this.writes.run(() => this.doStartMaintenance(hours, who, now));
  }

  private async doStartMaintenance(hours: number, who: Principal, now: number): Promise<string> {
    if (!(MAINTENANCE_HOURS as readonly number[]).includes(hours)) {
      throw new BadRequestException({ code: 'MAINTENANCE_HOURS', message: t('error.maintenanceHours', { hours: MAINTENANCE_HOURS.join(', ') }) });
    }
    await this.notifier?.securityAlert(who.name, [{ kind: 'maintenance', hours }]);
    const next = this.pruned(now);
    next.set(MAINTENANCE, now + hours * 3_600_000);
    await this.save(next);
    this.audit.log(`maintenance window for ${hours} h started by "${who.name}" (${who.id})`);
    return new Date(next.get(MAINTENANCE)!).toISOString();
  }

  endMaintenance(who: Principal, now = Date.now()): Promise<void> {
    return this.writes.run(() => this.doEndMaintenance(who, now));
  }

  private async doEndMaintenance(who: Principal, now: number): Promise<void> {
    const next = this.pruned(now);
    if (next.delete(MAINTENANCE)) {
      await this.save(next);
      this.audit.log(`maintenance window ended by "${who.name}" (${who.id})`);
    }
  }

  /** `severity`: of the issue as the agent sees it; silencing a critical one is announced through the channels first. */
  silence(issueId: string, hours: number, who: Principal, now = Date.now(), severity?: IssueSeverity): Promise<string> {
    return this.writes.run(() => this.doSilence(issueId, hours, who, now, severity));
  }

  private async doSilence(issueId: string, hours: number, who: Principal, now: number, severity?: IssueSeverity): Promise<string> {
    if (!issueId || issueId.length > 300 || issueId === MAINTENANCE) {
      throw new BadRequestException({ code: 'ISSUE_MISSING', message: t('error.issueMissing') });
    }
    if (!(SILENCE_HOURS as readonly number[]).includes(hours)) {
      throw new BadRequestException({ code: 'SILENCE_HOURS', message: t('error.silenceHours', { hours: SILENCE_HOURS.join(', ') }) });
    }
    const next = this.pruned(now);
    next.set(issueId, now + hours * 3_600_000);
    if (next.size > MAX_SILENCED) {
      throw new BadRequestException({ code: 'SILENCE_LIMIT', message: t('error.silenceLimit') });
    }
    // Before it takes effect, like a maintenance window: a silenced critical issue sends nothing more.
    const events = this.silenceEvents(issueId, hours, now, severity);
    if (events.length > 0) {
      await this.notifier?.securityAlert(who.name, events);
    }
    await this.save(next);
    this.audit.log(`issue ${logSafe(issueId)} silenced for ${hours} h by "${who.name}" (${who.id})`);
    return new Date(next.get(issueId)!).toISOString();
  }

  unsilence(issueId: string, who: Principal, now = Date.now()): Promise<void> {
    return this.writes.run(() => this.doUnsilence(issueId, who, now));
  }

  private async doUnsilence(issueId: string, who: Principal, now: number): Promise<void> {
    const next = this.pruned(now);
    if (issueId !== MAINTENANCE && next.delete(issueId)) {
      await this.save(next);
      this.audit.log(`issue ${logSafe(issueId)} unsilenced by "${who.name}" (${who.id})`);
    }
  }

  /**
   * What silencing this issue announces: every critical issue, and once per
   * window a summary when BULK_SILENCES or more were silenced within
   * BULK_WINDOW_MS (warnings silenced one by one would otherwise go unnoticed).
   */
  private silenceEvents(issueId: string, hours: number, now: number, severity: IssueSeverity | undefined): SecurityEvent[] {
    this.recent = [...this.recent.filter((at) => now - at < BULK_WINDOW_MS), now];
    const events: SecurityEvent[] = [];
    if (severity === 'critical') {
      events.push({ kind: 'silenced', issue: issueId, hours });
    }
    if (this.recent.length >= BULK_SILENCES && now - this.bulkAnnouncedAt >= BULK_WINDOW_MS) {
      this.bulkAnnouncedAt = now;
      events.push({ kind: 'silencedMany', n: this.recent.length, minutes: BULK_WINDOW_MS / 60_000 });
    }
    return events;
  }

  private pruned(now: number): Map<string, number> {
    return new Map([...this.until].filter(([, until]) => until > now));
  }

  private async save(next: Map<string, number>): Promise<void> {
    await upsertConfigMapData(this.kube, this.config.namespace, SETTINGS_CONFIGMAP, { silenced: JSON.stringify(Object.fromEntries(next)) });
    this.until = next;
  }
}
