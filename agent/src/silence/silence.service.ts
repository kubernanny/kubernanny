import { BadRequestError } from '../http/errors';
import { Logger } from '../logger';
import type { Principal } from '../auth/devices.service';
import type { Config } from '../config';
import { t } from '../i18n/text';
import { KubeClient } from '../kube/kube-client';
import { IssueSeverity } from '../checks/types';
import { Notifier, SecurityEvent } from '../notify/notifier';
import { logSafe } from '../util/log-safe';
import { SETTINGS_CONFIGMAP } from '../settings/settings.service';
import { Serial } from '../util/serial';
import { upsertConfigMapData } from '../kube/configmap';
import { NotLoadedError, readAtStartup } from '../util/startup-read';

/** The durations the app offers; anything else is refused, so nobody silences an issue for a year by accident. */
const SILENCE_HOURS = [1, 8, 24, 168] as const;
/** A maintenance window: no notifications at all, for planned work on the cluster. */
const MAINTENANCE_HOURS = [1, 2, 4, 8, 24] as const;
const MAX_SILENCED = 500;
const RANK: Record<IssueSeverity, number> = { info: 0, warning: 1, critical: 2 };

/** One silence: until when, and the severity the issue had when it was silenced. */
interface Silence {
  until: number;
  severity: IssueSeverity;
}
/** Stored next to the silenced issues; no issue id is a lone asterisk. */
const MAINTENANCE = '*';

/**
 * Issues someone silenced for a while (a maintenance window, a known slow
 * backup). A silenced issue stays visible, but costs no light, no score and
 * sends no notification until it expires. Kept under the key `silenced` of
 * the ConfigMap `kubernanny-settings`, next to the switches, so it survives
 * restarts.
 *
 * Two rules keep a silence from blinding the owner (a stolen phone's easiest
 * move): every silence of a warning or an outage is announced through the
 * channels before it takes effect, and a silence only covers the severity
 * the issue had when it was silenced. A warning silenced today that turns
 * critical tomorrow is no longer silenced and notifies like any outage.
 */
export class SilenceService {
  private readonly audit = new Logger('audit');
  private until = new Map<string, Silence>();
  /** True once the stored silences were read: a write before that would replace them with this empty map. */
  private loaded = false;
  /** Every change reads, changes and writes the whole map: one at a time, or two at once lose one. */
  private readonly writes = new Serial();

  constructor(
    private readonly config: Config,
    private readonly kube: KubeClient,
    /** Announces maintenance windows; absent in unit tests that do not care. */
    private readonly notifier?: Notifier,
  ) {}

  private get path(): string {
    return `/api/v1/namespaces/${encodeURIComponent(this.config.namespace)}/configmaps`;
  }

  /** Reads the stored silences, retrying transient errors; throws when they stay unreadable, so the process ends and restarts. */
  async onModuleInit(): Promise<void> {
    const log = new Logger(SilenceService.name);
    const cm = await readAtStartup('silenced issues', () => this.kube.get<{ data?: { silenced?: string } }>(`${this.path}/${SETTINGS_CONFIGMAP}`), {
      onRetry: (err, attempt) => log.warn(`cannot read silenced issues (${err instanceof Error ? err.message : err}), attempt ${attempt}; retrying`),
    });
    this.until = parseSilences(cm?.data?.silenced);
    this.loaded = true;
  }

  /**
   * When the issue's silence ends, or null when it is not silenced: expired,
   * or the issue is worse now (`severity`) than when it was silenced.
   */
  silencedUntil(issueId: string, now = Date.now(), severity?: IssueSeverity): string | null {
    const silence = this.until.get(issueId);
    if (silence === undefined || silence.until <= now) {
      return null;
    }
    if (severity !== undefined && RANK[severity] > RANK[silence.severity]) {
      return null;
    }
    return new Date(silence.until).toISOString();
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
      throw new BadRequestError({ code: 'MAINTENANCE_HOURS', message: t('error.maintenanceHours', { hours: MAINTENANCE_HOURS.join(', ') }) });
    }
    await this.notifier?.securityAlert(who.name, [{ kind: 'maintenance', hours }]);
    const next = this.pruned(now);
    next.set(MAINTENANCE, { until: now + hours * 3_600_000, severity: 'critical' });
    await this.save(next);
    this.audit.log(`maintenance window for ${hours} h started by "${who.name}" (${who.id})`);
    return new Date(next.get(MAINTENANCE)!.until).toISOString();
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
      throw new BadRequestError({ code: 'ISSUE_MISSING', message: t('error.issueMissing') });
    }
    if (!(SILENCE_HOURS as readonly number[]).includes(hours)) {
      throw new BadRequestError({ code: 'SILENCE_HOURS', message: t('error.silenceHours', { hours: SILENCE_HOURS.join(', ') }) });
    }
    const next = this.pruned(now);
    // Unknown severity (an issue the caller did not look up) counts as a warning: an outage then still breaks through.
    next.set(issueId, { until: now + hours * 3_600_000, severity: severity ?? 'warning' });
    if (next.size > MAX_SILENCED) {
      throw new BadRequestError({ code: 'SILENCE_LIMIT', message: t('error.silenceLimit') });
    }
    // Before it takes effect, like a maintenance window: a silenced critical issue sends nothing more.
    const events = this.silenceEvents(issueId, hours, severity);
    if (events.length > 0) {
      await this.notifier?.securityAlert(who.name, events);
    }
    await this.save(next);
    this.audit.log(`issue ${logSafe(issueId)} silenced for ${hours} h by "${who.name}" (${who.id})`);
    return new Date(next.get(issueId)!.until).toISOString();
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

  /** What silencing this issue announces: every warning and outage. Hints never notify, so silencing one hides nothing. */
  private silenceEvents(issueId: string, hours: number, severity: IssueSeverity | undefined): SecurityEvent[] {
    return severity === 'info' ? [] : [{ kind: 'silenced', issue: issueId, hours }];
  }

  private pruned(now: number): Map<string, Silence> {
    return new Map([...this.until].filter(([, s]) => s.until > now));
  }

  private async save(next: Map<string, Silence>): Promise<void> {
    if (!this.loaded) {
      throw new NotLoadedError('silenced issues');
    }
    await upsertConfigMapData(this.kube, this.config.namespace, SETTINGS_CONFIGMAP, { silenced: JSON.stringify(Object.fromEntries(next)) });
    this.until = next;
  }
}

function parseSilences(text: string | undefined): Map<string, Silence> {
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(text ?? '{}') as Record<string, unknown>;
  } catch {
    return new Map();
  }
  return new Map(
    Object.entries(raw ?? {}).flatMap(([id, v]) => {
      const silence = parseSilence(v);
      return silence ? [[id, silence] as const] : [];
    }),
  );
}

/** A stored silence; plain numbers come from versions that stored no severity and count as covering warnings only. */
function parseSilence(v: unknown): Silence | null {
  if (typeof v === 'number') {
    return { until: v, severity: 'warning' };
  }
  if (v && typeof v === 'object') {
    const { until, severity } = v as { until?: unknown; severity?: unknown };
    if (typeof until === 'number' && (severity === 'info' || severity === 'warning' || severity === 'critical')) {
      return { until, severity };
    }
  }
  return null;
}
