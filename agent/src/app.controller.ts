import { BadGatewayException, BadRequestException, ForbiddenException, NotFoundException } from './http/errors';
import { Route, intQuery, strQuery, uuidParam } from './http/server';
import { Logger } from './logger';
import { AGENT_VERSION } from './version';
import { ActionsService } from './actions/actions.service';
import { DeviceView, DevicesService, Principal } from './auth/devices.service';
import { IdentityService } from './auth/identity.service';
import { IssueActionType } from './checks/types';
import { Text, t } from './i18n/text';
import type { Config } from './config';
import { Notifier } from './notify/notifier';
import { PairingService } from './pairing/pairing';
import { RelayClient } from './relay/relay-client';
import { SettingsPatch, SettingsService, SettingsView } from './settings/settings.service';
import { SilenceService } from './silence/silence.service';
import { Snapshot, StatusService } from './status/status.service';
import { HistoryView, agentHistory, prometheusHistory } from './views/history';
import { buildEvents, buildNetwork, buildNodes, buildStorage, buildWorkloads } from './views/views';
import { BackupsView, buildBackups } from './views/backups';
import { IncidentsView } from './views/incidents';
import { IncidentsService } from './incidents/incidents.service';

const RUNNABLE: IssueActionType[] = ['argocd-sync', 'argocd-refresh', 'restart', 'cnpg-backup'];
export { AGENT_VERSION };

export class AppController {
  private readonly logger = new Logger('audit');
  private historyCache: { key: string; at: number; value: HistoryView } | null = null;

  constructor(
    private readonly status: StatusService,
    private readonly actions: ActionsService,
    private readonly notifier: Notifier,
    private readonly devicesService: DevicesService,
    private readonly identity: IdentityService,
    private readonly config: Config,
    private readonly pairing: PairingService,
    private readonly settings: SettingsService,
    private readonly relay: RelayClient,
    private readonly silences: SilenceService,
    private readonly incidents: IncidentsService,
  ) {}

  /** Liveness only, no cluster data: the one plain route besides /api/identity and /api/e2e. */
  health(): { ok: true } {
    return { ok: true };
  }

  /** Every paired device; any paired device may see and revoke the others (the lost-phone case). */
  devices(who: Principal): (DeviceView & { current: boolean })[] {
    return this.devicesService.list().map((d) => ({ ...d, current: who.kind === 'device' && who.id === d.id }));
  }

  async revoke(id: string, who: Principal): Promise<void> {
    const target = this.devicesService.byId(id);
    if (target) {
      // Before it takes effect: revoking every other device is how a stolen one would lock the owner out.
      await this.notifier.securityAlert(who.name, [{ kind: 'deviceRevoked', device: target.name }]);
    }
    if (!target || !(await this.devicesService.revoke(id))) {
      throw new NotFoundException({ code: 'DEVICE_NOT_FOUND', message: t('error.deviceNotFound') });
    }
    this.logger.log(`device ${id} revoked by "${who.name}"`);
  }

  /** A new pairing code for another device, from a device that is already paired. */
  newCode(who: Principal): { code: string; app: string; web: string | null } {
    const code = this.pairing.issue();
    const { app, web } = this.pairing.links(code);
    this.logger.log(`pairing code issued by "${who.name}"`);
    return { code, app, web };
  }

  /** The start banner with a fresh code, for the admin CLI (`node dist/cli.js pair`). */
  async newBanner(who: Principal): Promise<string> {
    if (who.kind !== 'admin') {
      throw new ForbiddenException({ code: 'ADMIN_ONLY', message: t('error.adminOnly') });
    }
    this.logger.log('pairing code issued by the admin CLI');
    return this.pairing.banner(this.pairing.issue());
  }

  /** What runs: modules, action types, notifications, each on, off (app) or locked (deployment). */
  settingsView(): SettingsView {
    return this.settings.view(this.status.state().detected.map((d) => d.entry.id));
  }

  /** Switches within the deployment's limits; `{ modules: { argocd: false }, actions: { restart: false }, notifications: true }`. */
  async changeSettings(patch: SettingsPatch, who: Principal): Promise<SettingsView> {
    if (typeof patch !== 'object' || patch === null) {
      throw new BadRequestException({ code: 'SETTING_UNKNOWN', message: t('error.bodyMissing') });
    }
    await this.settings.update(patch, who);
    return this.settingsView();
  }

  /** Silences an open issue for 1, 8, 24 or 168 hours; it stays visible but costs no light, score or notification. */
  async silence(issue: string, hours: number, who: Principal): Promise<{ silencedUntil: string }> {
    const found = this.status.findIssue(issue);
    if (!found) {
      throw new NotFoundException({ code: 'ISSUE_GONE', message: t('error.issueGone') });
    }
    const silencedUntil = await this.silences.silence(issue, hours, who, Date.now(), found.severity);
    await this.status.refreshAfterChange();
    return { silencedUntil };
  }

  async unsilence(issue: string, who: Principal): Promise<void> {
    await this.silences.unsilence(issue ?? '', who);
    await this.status.refreshAfterChange();
  }

  /** A maintenance window of 1, 2, 4, 8 or 24 hours: the checks go on, notifications wait until it ends. */
  async startMaintenance(hours: number, who: Principal): Promise<{ maintenanceUntil: string }> {
    const maintenanceUntil = await this.silences.startMaintenance(hours, who);
    await this.status.refreshAfterChange();
    return { maintenanceUntil };
  }

  async endMaintenance(who: Principal): Promise<void> {
    await this.silences.endMaintenance(who);
    await this.status.refreshAfterChange();
  }

  info() {
    const { prom, detected } = this.status.state();
    return {
      agentVersion: AGENT_VERSION,
      cluster: this.config.clusterName,
      intervalSeconds: this.config.intervalSeconds,
      notifyAfterSeconds: this.config.notifyAfterSeconds,
      channels: this.notifier.channels,
      agentKey: this.identity.publicKey,
      agentFingerprint: this.identity.fingerprint,
      prometheus: prom !== null,
      components: detected.map((d) => d.entry.id),
      // The relay's address and whether the agent is connected to it; null without RELAY_URL.
      relay: this.relay.status(),
    };
  }

  get(): Snapshot {
    return this.status.snapshot();
  }

  async refresh(): Promise<Snapshot> {
    await this.status.refresh();
    return this.status.snapshot();
  }

  nodes() {
    const { inv, data } = this.status.state();
    return buildNodes(inv, data);
  }

  workloads() {
    const { inv, detected } = this.status.state();
    return buildWorkloads(inv, detected);
  }

  storage() {
    const { inv, data } = this.status.state();
    return buildStorage(inv, data);
  }

  network() {
    const { inv, data, detected } = this.status.state();
    return buildNetwork(inv, data, detected);
  }

  events() {
    return buildEvents(this.status.state().inv);
  }

  /** The issues of the last 1 to 7 days (default 7) as episodes, newest first, from the agent's memory. */
  incidentHistory(daysParam?: number): IncidentsView {
    return this.incidents.view(Math.min(Math.max(daysParam ?? 7, 1), 7), Date.now());
  }

  /** Every backup the modules know about, one row per protected thing, judged like the checks judge it. */
  backups(): BackupsView {
    const { data } = this.status.state();
    const checkedAt = this.status.snapshot().checkedAt;
    return buildBackups(data, checkedAt ? new Date(checkedAt) : new Date(), this.config.backupMaxAgeHours);
  }

  /** CPU, RAM, network, restarts, etcd over time: from Prometheus when there is one, else the agent's own memory. */
  async history(hoursParam?: number): Promise<HistoryView> {
    const hours = Math.min(Math.max(hoursParam ?? 6, 1), 168);
    const { prom, inv } = this.status.state();
    if (!prom) {
      return agentHistory(this.status.history(), Math.min(hours, 6));
    }
    const key = String(hours);
    if (this.historyCache && this.historyCache.key === key && Date.now() - this.historyCache.at < 60_000) {
      return this.historyCache.value;
    }
    const value = await prometheusHistory(prom, inv, hours).catch(() => agentHistory(this.status.history(), Math.min(hours, 6)));
    this.historyCache = { key, at: Date.now(), value };
    return value;
  }

  // Issue ids contain slashes, so they travel as a query parameter.
  run(
    type: string,
    issue: string,
    who: Principal,
    index?: number,
  ): Promise<{ done: Text }> {
    if (!issue || !RUNNABLE.includes(type as IssueActionType)) {
      throw new BadRequestException({ code: 'ACTION_UNKNOWN', message: t('error.actionUnknown', { type }) });
    }
    return this.actions.run(issue, type as IssueActionType, index ?? 0, who);
  }

  logs(issue: string, who: Principal, index?: number) {
    if (!issue) {
      throw new BadRequestException({ code: 'ISSUE_MISSING', message: t('error.issueMissing') });
    }
    return this.actions.logs(issue, index ?? 0, who);
  }

  async testNotification(): Promise<{ channels: string[] }> {
    if (this.notifier.locked) {
      throw new ForbiddenException({ code: 'NOTIFICATIONS_LOCKED', message: t('error.notificationsLocked') });
    }
    if (this.notifier.channels.length === 0) {
      throw new BadRequestException({ code: 'NO_CHANNEL', message: t('error.noChannel') });
    }
    try {
      return { channels: await this.notifier.test(this.config.clusterName) };
    } catch (err) {
      throw new BadGatewayException({ code: 'NOTIFY_FAILED', message: t('error.notifyTestFailed', { error: err instanceof Error ? err.message.slice(0, 300) : String(err) }) });
    }
  }
}

/** The routes of AppController; `/healthz` is outside /api, like it always was. */
export function appRoutes(c: AppController): Route[] {
  return [
    // Liveness only, no cluster data: the plain routes besides /readyz, /api/identity and /api/e2e.
    { method: 'GET', path: '/healthz', public: true, handle: () => c.health() },
    { method: 'GET', path: '/api/devices', handle: (r) => c.devices(r.principal) },
    { method: 'DELETE', write: true, path: '/api/devices/:id', status: 204, handle: (r) => c.revoke(uuidParam(r, 'id'), r.principal) },
    { method: 'POST', write: true, path: '/api/pair/code', handle: (r) => c.newCode(r.principal) },
    { method: 'POST', write: true, path: '/api/pair/code/banner', textType: 'text/plain; charset=utf-8', handle: (r) => c.newBanner(r.principal) },
    { method: 'GET', path: '/api/settings', handle: () => c.settingsView() },
    { method: 'POST', write: true, path: '/api/settings', handle: (r) => c.changeSettings(r.body as SettingsPatch, r.principal) },
    { method: 'POST', write: true, path: '/api/issues/silence', handle: (r) => c.silence(strQuery(r, 'issue'), intQuery(r, 'hours'), r.principal) },
    { method: 'POST', write: true, path: '/api/issues/unsilence', status: 204, handle: (r) => c.unsilence(strQuery(r, 'issue'), r.principal) },
    { method: 'POST', write: true, path: '/api/maintenance', handle: (r) => c.startMaintenance(intQuery(r, 'hours'), r.principal) },
    { method: 'POST', write: true, path: '/api/maintenance/end', status: 204, handle: (r) => c.endMaintenance(r.principal) },
    { method: 'GET', path: '/api/info', handle: () => c.info() },
    { method: 'GET', path: '/api/status', handle: () => c.get() },
    { method: 'POST', path: '/api/status/refresh', handle: () => c.refresh() },
    { method: 'GET', path: '/api/nodes', handle: () => c.nodes() },
    { method: 'GET', path: '/api/workloads', handle: () => c.workloads() },
    { method: 'GET', path: '/api/storage', handle: () => c.storage() },
    { method: 'GET', path: '/api/network', handle: () => c.network() },
    { method: 'GET', path: '/api/events', handle: () => c.events() },
    { method: 'GET', path: '/api/incidents', handle: (r) => c.incidentHistory(intQuery(r, 'days', true)) },
    { method: 'GET', path: '/api/backups', handle: () => c.backups() },
    { method: 'GET', path: '/api/history', handle: (r) => c.history(intQuery(r, 'hours', true)) },
    // Issue ids contain slashes, so they travel as a query parameter.
    { method: 'POST', write: true, path: '/api/actions/:type', handle: (r) => c.run(r.params.type, strQuery(r, 'issue'), r.principal, intQuery(r, 'index', true)) },
    { method: 'GET', path: '/api/logs', handle: (r) => c.logs(strQuery(r, 'issue'), r.principal, intQuery(r, 'index', true)) },
    { method: 'POST', write: true, path: '/api/notify/test', handle: () => c.testNotification() },
  ];
}
