import { BadRequestError, ForbiddenError } from '../../http/errors';
import { Logger } from '../../logger';
import type { Principal } from '../../auth/devices.service';
import type { Config } from '../../config';
import { t } from '../../i18n/text';
import { KubeClient } from '../../kube/kube-client';
import { Notifier } from '../../notify/notifier';
import { SETTINGS_CONFIGMAP, SettingsService } from '../../settings/settings.service';
import { Serial } from '../../util/serial';
import { logSafe } from '../../util/log-safe';
import { upsertConfigMapData } from '../../kube/configmap';
import { NotLoadedError, readAtStartup } from '../../util/startup-read';
import { ACCEPT_DAYS, ADVISORY, Acceptance, AcceptanceState, COMPONENT, DAY, MAX_ACCEPTED, acceptanceKey, cleanReason, parseAccepted } from './acceptance';

export { ACCEPT_DAYS, acceptanceKey } from './acceptance';

/** The modules whose advisories can be accepted: the built-in lookup and Trivy Operator's reports. */
const ACCEPTING_MODULES = ['vulnerabilities', 'trivy'];
export type { Acceptance, AcceptanceState } from './acceptance';

/**
 * Advisories accepted per component ("does not apply here": the vulnerable
 * code path is not used, a mitigation is in place). An accepted advisory no
 * longer counts for its component's issue and is listed as accepted on the
 * module sheet until it expires. Kept under the key `accepted` of the
 * ConfigMap `kubernanny-settings`, like silences.
 *
 * Helm `vulnerabilities.allowAccept: false` (VULN_ACCEPT=off) refuses every
 * change before reading or writing anything, and makes the check ignore what
 * is stored, so an acceptance made before the switch cannot hide anything.
 */
export class AcceptanceService {
  private readonly audit = new Logger('audit');
  private accepted = new Map<string, Acceptance>();
  /** True once the stored acceptances were read: a write before that would replace them with this empty map. */
  private loaded = false;
  private readonly writes = new Serial();

  constructor(
    private readonly config: Config,
    private readonly kube: KubeClient,
    private readonly settings: SettingsService,
    /** Announces every acceptance; absent in unit tests that do not care. */
    private readonly notifier?: Notifier,
  ) {}

  private get path(): string {
    return `/api/v1/namespaces/${encodeURIComponent(this.config.namespace)}/configmaps`;
  }

  /** Reads the stored acceptances, retrying transient errors; throws when they stay unreadable, so the process ends and restarts. */
  async onModuleInit(): Promise<void> {
    if (this.config.vulnAcceptLocked) {
      return;
    }
    const log = new Logger(AcceptanceService.name);
    const cm = await readAtStartup('accepted advisories', () => this.kube.get<{ data?: { accepted?: string } }>(`${this.path}/${SETTINGS_CONFIGMAP}`), {
      onRetry: (err, attempt) => log.warn(`cannot read accepted advisories (${err instanceof Error ? err.message : err}), attempt ${attempt}; retrying`),
    });
    this.accepted = parseAccepted(cm?.data?.accepted);
    this.loaded = true;
  }

  /** Locked in Helm, or neither the built-in lookup nor the Trivy integration runs: the app hides the button, the routes refuse. */
  allowed(): boolean {
    return !this.config.vulnAcceptLocked && this.anyModuleOn();
  }

  private anyModuleOn(): boolean {
    return ACCEPTING_MODULES.some((id) => this.settings.moduleOn(id));
  }

  state(now = Date.now()): AcceptanceState {
    if (this.config.vulnAcceptLocked) {
      return { allowed: false, accepted: new Map() };
    }
    return { allowed: this.allowed(), accepted: this.pruned(now) };
  }

  async accept(component: string, advisory: string, days: number, reason: unknown, who: Principal, now = Date.now()): Promise<string> {
    this.assertAllowed();
    return await this.writes.run(() => this.doAccept(component, advisory, days, reason, who, now));
  }

  async unaccept(component: string, advisory: string, who: Principal, now = Date.now()): Promise<void> {
    this.assertAllowed();
    await this.writes.run(() => this.doUnaccept(component, advisory, who, now));
  }

  /** Before anything else, so a locked install never reads or writes the stored list. */
  assertAllowed(): void {
    if (this.config.vulnAcceptLocked) {
      throw new ForbiddenError({ code: 'ACCEPT_LOCKED', message: t('error.acceptLocked') });
    }
    if (!this.anyModuleOn()) {
      throw new ForbiddenError({ code: 'MODULE_OFF', message: t('error.vulnerabilitiesOff') });
    }
  }

  private async doAccept(component: string, advisory: string, days: number, reason: unknown, who: Principal, now: number): Promise<string> {
    checkIds(component, advisory);
    if (!(ACCEPT_DAYS as readonly number[]).includes(days)) {
      throw new BadRequestError({ code: 'ACCEPT_DAYS', message: t('error.acceptDays', { days: ACCEPT_DAYS.join(', ') }) });
    }
    if (reason !== undefined && typeof reason !== 'string') {
      throw new BadRequestError({ code: 'ACCEPT_REASON', message: t('error.acceptReason') });
    }
    const next = this.pruned(now);
    const text = cleanReason(reason);
    next.set(acceptanceKey(component, advisory), { until: now + days * DAY, at: now, by: who.name, ...(text ? { reason: text } : {}) });
    if (next.size > MAX_ACCEPTED) {
      throw new BadRequestError({ code: 'ACCEPT_LIMIT', message: t('error.acceptLimit') });
    }
    // Before it takes effect: hiding a real advisory is what a stolen device would do.
    await this.notifier?.securityAlert(who.name, [{ kind: 'advisoryAccepted', component, advisory, days }]);
    await this.save(next);
    this.audit.log(`advisory ${logSafe(advisory)} on ${logSafe(component)} accepted for ${days} days by "${who.name}" (${who.id})${text ? `: ${JSON.stringify(text)}` : ''}`);
    return new Date(now + days * DAY).toISOString();
  }

  private async doUnaccept(component: string, advisory: string, who: Principal, now: number): Promise<void> {
    checkIds(component, advisory);
    const next = this.pruned(now);
    if (next.delete(acceptanceKey(component, advisory))) {
      await this.save(next);
      this.audit.log(`advisory ${logSafe(advisory)} on ${logSafe(component)} no longer accepted, by "${who.name}" (${who.id})`);
    }
  }

  private pruned(now: number): Map<string, Acceptance> {
    return new Map([...this.accepted].filter(([, a]) => a.until > now));
  }

  private async save(next: Map<string, Acceptance>): Promise<void> {
    if (!this.loaded) {
      throw new NotLoadedError('accepted advisories');
    }
    await upsertConfigMapData(this.kube, this.config.namespace, SETTINGS_CONFIGMAP, { accepted: JSON.stringify(Object.fromEntries(next)) });
    this.accepted = next;
  }
}

function checkIds(component: string, advisory: string): void {
  if (typeof component !== 'string' || !COMPONENT.test(component) || typeof advisory !== 'string' || !ADVISORY.test(advisory)) {
    throw new BadRequestError({ code: 'ACCEPT_TARGET', message: t('error.acceptTarget') });
  }
}
