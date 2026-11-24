import { BadRequestException, Body, Controller, Delete, ForbiddenException, Res, Logger, Get, HttpCode, Inject, NotFoundException, Param, ParseIntPipe, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import type { Response } from 'express';
import { AGENT_VERSION } from './version';
import { ActionsService } from './actions/actions.service';
import { DeviceView, DevicesService, Principal } from './auth/devices.service';
import { IdentityService } from './auth/identity.service';
import { CurrentPrincipal, Public } from './auth/principal.guard';
import { IssueActionType } from './checks/types';
import { Text, t } from './i18n/text';
import { CONFIG, Config } from './config';
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

@Controller()
export class AppController {
  private readonly logger = new Logger('audit');
  private historyCache: { key: string; at: number; value: HistoryView } | null = null;

  constructor(
    @Inject(StatusService) private readonly status: StatusService,
    @Inject(ActionsService) private readonly actions: ActionsService,
    @Inject(Notifier) private readonly notifier: Notifier,
    @Inject(DevicesService) private readonly devicesService: DevicesService,
    @Inject(IdentityService) private readonly identity: IdentityService,
    @Inject(CONFIG) private readonly config: Config,
    @Inject(PairingService) private readonly pairing: PairingService,
    @Inject(SettingsService) private readonly settings: SettingsService,
    @Inject(RelayClient) private readonly relay: RelayClient,
    @Inject(SilenceService) private readonly silences: SilenceService,
    @Inject(IncidentsService) private readonly incidents: IncidentsService,
  ) {}

  /** Liveness only, no cluster data: the one plain route besides /api/identity and /api/e2e. */
  @Public()
  @Get('healthz')
  health(): { ok: true } {
    return { ok: true };
  }

  /** Every paired device; any paired device may see and revoke the others (the lost-phone case). */
  @Get('devices')
  devices(@CurrentPrincipal() who: Principal): (DeviceView & { current: boolean })[] {
    return this.devicesService.list().map((d) => ({ ...d, current: who.kind === 'device' && who.id === d.id }));
  }

  @Delete('devices/:id')
  @HttpCode(204)
  async revoke(@Param('id', new ParseUUIDPipe()) id: string, @CurrentPrincipal() who: Principal): Promise<void> {
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
  @Post('pair/code')
  @HttpCode(200)
  newCode(@CurrentPrincipal() who: Principal): { code: string; app: string; web: string | null } {
    const code = this.pairing.issue();
    const { app, web } = this.pairing.links(code);
    this.logger.log(`pairing code issued by "${who.name}"`);
    return { code, app, web };
  }

  /** The start banner with a fresh code, for the admin CLI (`node dist/cli.js pair`). */
  @Post('pair/code/banner')
  @HttpCode(200)
  async newBanner(@CurrentPrincipal() who: Principal, @Res({ passthrough: true }) res: Response): Promise<string> {
    if (who.kind !== 'admin') {
      throw new ForbiddenException({ code: 'ADMIN_ONLY', message: t('error.adminOnly') });
    }
    res.type('text/plain');
    this.logger.log('pairing code issued by the admin CLI');
    return this.pairing.banner(this.pairing.issue());
  }

  /** What runs: modules, action types, notifications, each on, off (app) or locked (deployment). */
  @Get('settings')
  settingsView(): SettingsView {
    return this.settings.view(this.status.state().detected.map((d) => d.entry.id));
  }

  /** Switches within the deployment's limits; `{ modules: { argocd: false }, actions: { restart: false }, notifications: true }`. */
  @Post('settings')
  @HttpCode(200)
  async changeSettings(@Body() patch: SettingsPatch, @CurrentPrincipal() who: Principal): Promise<SettingsView> {
    if (typeof patch !== 'object' || patch === null) {
      throw new BadRequestException({ code: 'SETTING_UNKNOWN', message: t('error.bodyMissing') });
    }
    await this.settings.update(patch, who);
    return this.settingsView();
  }

  /** Silences an open issue for 1, 8, 24 or 168 hours; it stays visible but costs no light, score or notification. */
  @Post('issues/silence')
  @HttpCode(200)
  async silence(@Query('issue') issue: string, @Query('hours', new ParseIntPipe()) hours: number, @CurrentPrincipal() who: Principal): Promise<{ silencedUntil: string }> {
    if (!this.status.findIssue(issue)) {
      throw new NotFoundException({ code: 'ISSUE_GONE', message: t('error.issueGone') });
    }
    const silencedUntil = await this.silences.silence(issue, hours, who);
    await this.status.refreshAfterChange();
    return { silencedUntil };
  }

  @Post('issues/unsilence')
  @HttpCode(204)
  async unsilence(@Query('issue') issue: string, @CurrentPrincipal() who: Principal): Promise<void> {
    await this.silences.unsilence(issue ?? '', who);
    await this.status.refreshAfterChange();
  }

  /** A maintenance window of 1, 2, 4, 8 or 24 hours: the checks go on, notifications wait until it ends. */
  @Post('maintenance')
  @HttpCode(200)
  async startMaintenance(@Query('hours', new ParseIntPipe()) hours: number, @CurrentPrincipal() who: Principal): Promise<{ maintenanceUntil: string }> {
    const maintenanceUntil = await this.silences.startMaintenance(hours, who);
    await this.status.refreshAfterChange();
    return { maintenanceUntil };
  }

  @Post('maintenance/end')
  @HttpCode(204)
  async endMaintenance(@CurrentPrincipal() who: Principal): Promise<void> {
    await this.silences.endMaintenance(who);
    await this.status.refreshAfterChange();
  }

  @Get('info')
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

  @Get('status')
  get(): Snapshot {
    return this.status.snapshot();
  }

  @Post('status/refresh')
  @HttpCode(200)
  async refresh(): Promise<Snapshot> {
    await this.status.refresh();
    return this.status.snapshot();
  }

  @Get('nodes')
  nodes() {
    const { inv, data } = this.status.state();
    return buildNodes(inv, data);
  }

  @Get('workloads')
  workloads() {
    const { inv, detected } = this.status.state();
    return buildWorkloads(inv, detected);
  }

  @Get('storage')
  storage() {
    const { inv, data } = this.status.state();
    return buildStorage(inv, data);
  }

  @Get('network')
  network() {
    const { inv, data, detected } = this.status.state();
    return buildNetwork(inv, data, detected);
  }

  @Get('events')
  events() {
    return buildEvents(this.status.state().inv);
  }

  /** The issues of the last 1 to 7 days (default 7) as episodes, newest first, from the agent's memory. */
  @Get('incidents')
  incidentHistory(@Query('days', new ParseIntPipe({ optional: true })) daysParam?: number): IncidentsView {
    return this.incidents.view(Math.min(Math.max(daysParam ?? 7, 1), 7), Date.now());
  }

  /** Every backup the modules know about, one row per protected thing, judged like the checks judge it. */
  @Get('backups')
  backups(): BackupsView {
    const { data } = this.status.state();
    const checkedAt = this.status.snapshot().checkedAt;
    return buildBackups(data, checkedAt ? new Date(checkedAt) : new Date(), this.config.backupMaxAgeHours);
  }

  /** CPU, RAM, network, restarts, etcd over time: from Prometheus when there is one, else the agent's own memory. */
  @Get('history')
  async history(@Query('hours', new ParseIntPipe({ optional: true })) hoursParam?: number): Promise<HistoryView> {
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
  @Post('actions/:type')
  @HttpCode(200)
  run(
    @Param('type') type: string,
    @Query('issue') issue: string,
    @CurrentPrincipal() who: Principal,
    @Query('index', new ParseIntPipe({ optional: true })) index?: number,
  ): Promise<{ done: Text }> {
    if (!issue || !RUNNABLE.includes(type as IssueActionType)) {
      throw new BadRequestException({ code: 'ACTION_UNKNOWN', message: t('error.actionUnknown', { type }) });
    }
    return this.actions.run(issue, type as IssueActionType, index ?? 0, who);
  }

  @Get('logs')
  logs(@Query('issue') issue: string, @CurrentPrincipal() who: Principal, @Query('index', new ParseIntPipe({ optional: true })) index?: number) {
    if (!issue) {
      throw new BadRequestException({ code: 'ISSUE_MISSING', message: t('error.issueMissing') });
    }
    return this.actions.logs(issue, index ?? 0, who);
  }

  @Post('notify/test')
  @HttpCode(200)
  async testNotification(): Promise<{ channels: string[] }> {
    if (this.notifier.channels.length === 0) {
      throw new BadRequestException({ code: 'NO_CHANNEL', message: t('error.noChannel') });
    }
    return { channels: await this.notifier.test(this.config.clusterName) };
  }
}
