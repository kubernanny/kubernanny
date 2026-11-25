import { Inject, Injectable, Logger, OnApplicationBootstrap, OnApplicationShutdown, Optional } from '@nestjs/common';
import { Issue } from '../checks/types';
import { CONFIG, Config } from '../config';
import { Detected, discover, distribution } from '../discovery/discovery';
import { Inventory, emptyInventory, gatherInventory } from '../inventory/inventory';
import { errorText, t } from '../i18n/text';
import { IncidentsService } from '../incidents/incidents.service';
import { KubeClient } from '../kube/kube-client';
import { CORE_CHECKS } from '../modules/core';
import { INTEGRATIONS, findPrometheus } from '../modules/integrations';
import { Prometheus } from '../modules/service-proxy';
import { ModuleContext, RunData } from '../modules/types';
import { VulnDb } from '../modules/vulnerabilities/osv-client';
import { vulnDbFor } from '../modules/vulnerabilities/vuln-db';
import { AcceptanceService } from '../modules/vulnerabilities/acceptance.service';
import { Notifier } from '../notify/notifier';
import { SettingsService } from '../settings/settings.service';
import { SilenceService } from '../silence/silence.service';
import { AGENT_VERSION } from '../version';
import { mergeIssues, runComponent, runCoreCheck } from './run-modules';
import { dedupeAlerts } from '../modules/core/standard-alerts/alertmanager-dedupe';
import { buildOverview, HistoryPoint, IssueView, lightFor, Overview, scoreFor, SEVERITY_RANK, Snapshot } from './snapshot';

// The types and rules of a snapshot live in snapshot.ts; existing imports keep working through here.
export * from './snapshot';

/** The synthetic issue raised while the agent cannot read the cluster. */
export const UNREACHABLE_ISSUE_ID = 'agent/cluster-unreachable';
/** One failed run is a blip (an API server restart); this many in a row are an outage worth a red light and a notification. */
export const UNREACHABLE_AFTER_RUNS = 3;

@Injectable()
export class StatusService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(StatusService.name);
  private snapshotValue: Snapshot;
  private inventory: Inventory = emptyInventory(new Date());
  private detected: Detected[] = [];
  private runData: RunData = {};
  private promClient: Prometheus | null = null;
  private readonly firstSeen = new Map<string, Date>();
  private readonly historyBuffer: HistoryPoint[] = [];
  private timer?: NodeJS.Timeout;
  private running: Promise<void> | null = null;
  /** Consecutive runs that could not read the cluster, and since when. */
  private failures = 0;
  private failingSince: string | null = null;
  /** Kept across runs: its cache is what limits the vulnerability check to two lookups a day. */
  private readonly vulnDb: VulnDb;

  constructor(
    @Inject(KubeClient) private readonly kube: KubeClient,
    @Inject(CONFIG) private readonly config: Config,
    @Inject(Notifier) private readonly notifier: Notifier,
    @Inject(SettingsService) private readonly settings: SettingsService,
    @Inject(SilenceService) private readonly silences: SilenceService,
    @Inject(IncidentsService) private readonly incidents: IncidentsService,
    /** Advisories marked as not applicable; absent where nobody wires it (they then all count). */
    @Optional() @Inject(AcceptanceService) private readonly acceptance?: AcceptanceService,
  ) {
    // A switch in the app takes effect at once, not with the next run.
    settings.onChange(() => void this.refreshAfterChange());
    this.snapshotValue = this.emptySnapshot();
    this.vulnDb = vulnDbFor(kube, config);
  }

  onApplicationBootstrap(): void {
    void this.refresh();
    this.timer = setInterval(() => void this.refresh(), this.config.intervalSeconds * 1000);
  }

  onApplicationShutdown(): void {
    clearInterval(this.timer);
  }

  /**
   * Runs everything; concurrent callers share one run. Never rejects: it is
   * started with `void` from timers and listeners, where a rejection would be
   * unhandled and end the process (a crash loop for whoever can make a run fail).
   */
  refresh(): Promise<void> {
    this.running ??= this.run()
      .catch((err: unknown) => {
        this.logger.error(`run failed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
      })
      .finally(() => {
        this.running = null;
      });
    return this.running;
  }

  /** A run that starts after now: a change (switch, silence) must not land in a run already under way. */
  refreshAfterChange(): Promise<void> {
    return this.running ? this.running.then(() => this.refresh()) : this.refresh();
  }

  snapshot(): Snapshot {
    return this.snapshotValue;
  }

  state(): { inv: Inventory; detected: Detected[]; data: RunData; prom: Prometheus | null } {
    return { inv: this.inventory, detected: this.detected, data: this.runData, prom: this.promClient };
  }

  /** CPU and memory share of the whole cluster, one point per run, from metrics-server. */
  history(): HistoryPoint[] {
    return this.historyBuffer;
  }

  findIssue(id: string): Issue | undefined {
    return this.snapshotValue.issues.find((i) => i.id === id);
  }

  private emptySnapshot(): Snapshot {
    return {
      cluster: this.config.clusterName,
      agentVersion: AGENT_VERSION,
      light: 'unknown',
      score: 0,
      checkedAt: null,
      durationMs: null,
      kubernetes: null,
      overview: null,
      modules: [],
      issues: [],
    };
  }

  /** One run: read the cluster, judge it, then publish (incidents, notifications). */
  private async run(): Promise<void> {
    const now = new Date();
    const started = Date.now();
    let inv: Inventory;
    try {
      inv = await gatherInventory(this.kube, now);
    } catch (err) {
      await this.publish(this.failedSnapshot(err, now), now);
      return;
    }
    this.failures = 0;
    this.failingSince = null;
    await this.publish(await this.buildSnapshot(inv, now, started), now);
  }

  /** The snapshot of a run that read the cluster: every enabled module, merged, ordered and judged. */
  private async buildSnapshot(inv: Inventory, now: Date, started: number): Promise<Snapshot> {
    const detected = discover(inv, this.config.customComponents);
    const data: RunData = {};
    const base = { inv, kube: this.kube, config: this.config, now, data };
    const prom = findPrometheus(base, detected);
    const ctx: ModuleContext = { ...base, prom, detected, vulnDb: this.vulnDb, vulnAcceptance: this.acceptance?.state(now.getTime()), rollbackOn: this.settings.actionOn('argocd-rollback') };
    const allowed = this.settings.actionOn;

    // Components first: some fill RunData the core checks read (kured lock, certificates).
    const components = await Promise.all(
      detected.filter((d) => this.settings.moduleOn(d.entry.id)).map((d) => runComponent(ctx, d, INTEGRATIONS.find((i) => i.id === d.entry.id), allowed)),
    );
    const core = await Promise.all(CORE_CHECKS.filter((m) => this.settings.moduleOn(m.id)).map((m) => runCoreCheck(ctx, m, allowed)));
    const byId = mergeIssues(core, components);
    // An Alertmanager alert that is the same as a built-in issue shows once, as the built-in one.
    dedupeAlerts(byId, [...core, ...components].map((o) => o.view), data, inv);
    const issues = this.withHistory([...byId.values()], now);
    const modules = [...core, ...components].map((a) => a.view);
    const overview = buildOverview(inv, detected.length, prom !== null);
    this.inventory = inv;
    this.detected = detected;
    this.runData = data;
    this.promClient = prom;
    this.record(now, overview);

    const maintenanceUntil = this.silences.maintenanceUntil(now.getTime());
    const audible = issues.filter((i) => !i.silencedUntil);
    return {
      cluster: this.config.clusterName,
      agentVersion: AGENT_VERSION,
      light: lightFor(modules, audible),
      score: scoreFor(audible),
      checkedAt: now.toISOString(),
      durationMs: Date.now() - started,
      kubernetes: { version: inv.version?.gitVersion, distribution: distribution(inv) },
      overview,
      modules,
      issues,
      ...(maintenanceUntil ? { maintenanceUntil } : {}),
    };
  }

  /**
   * The cluster could not be read. The last good run stays (and its
   * `checkedAt`, so the app and the metrics show how old it is), with
   * `failingSince` and the error. From the UNREACHABLE_AFTER_RUNS-th failure
   * on, the light turns red and one critical issue joins the others, which
   * goes through incidents and notifications like any issue.
   */
  private failedSnapshot(err: unknown, now: Date): Snapshot {
    this.logger.warn(`inventory failed: ${err instanceof Error ? err.message : String(err)}`);
    this.failures++;
    this.failingSince ??= now.toISOString();
    const previous: Snapshot = { ...this.snapshotValue, error: errorText(err), failingSince: this.failingSince };
    // Read now, not carried over: a window started since the last good run counts.
    const maintenanceUntil = this.silences.maintenanceUntil(now.getTime());
    delete previous.maintenanceUntil;
    if (maintenanceUntil) {
      previous.maintenanceUntil = maintenanceUntil;
    }
    const kept = previous.issues.filter((i) => i.id !== UNREACHABLE_ISSUE_ID);
    if (this.failures < UNREACHABLE_AFTER_RUNS) {
      // At least yellow (stale), never better than the last good run: a red cluster does not turn yellow for losing its API server.
      return { ...previous, light: !previous.modules.length ? 'unknown' : previous.light === 'red' ? 'red' : 'yellow' };
    }
    const unreachable: Issue & { module: string } = {
      id: UNREACHABLE_ISSUE_ID,
      check: 'agent',
      module: 'agent',
      severity: 'critical',
      title: t('agent.unreachable.title'),
      cause: t('agent.unreachable.cause', { error: errorText(err) }),
      actions: [],
    };
    this.firstSeen.set(UNREACHABLE_ISSUE_ID, new Date(this.failingSince));
    const issues = [...this.withHistory([unreachable], now), ...kept];
    const audible = issues.filter((i) => !i.silencedUntil);
    return {
      ...previous,
      light: audible.some((i) => i.severity === 'critical') ? 'red' : previous.modules.length ? 'yellow' : 'unknown',
      score: scoreFor(audible),
      issues,
    };
  }

  /** Adds `since` (first seen) and `silencedUntil`, forgets issues that are gone, and orders by severity. */
  private withHistory(found: (Issue & { module: string })[], now: Date): IssueView[] {
    const ids = new Set(found.map((i) => i.id));
    for (const id of ids) {
      if (!this.firstSeen.has(id)) {
        this.firstSeen.set(id, now);
      }
    }
    if (found.every((i) => i.id !== UNREACHABLE_ISSUE_ID)) {
      for (const id of [...this.firstSeen.keys()]) {
        if (!ids.has(id)) {
          this.firstSeen.delete(id);
        }
      }
    }
    return (
      found
        .map((i) => {
          const silencedUntil = this.silences.silencedUntil(i.id, now.getTime(), i.severity);
          return { ...i, since: this.firstSeen.get(i.id)!.toISOString(), ...(silencedUntil ? { silencedUntil } : {}) };
        })
        // Ties keep the order the modules reported them in (the sort is stable), never the title:
        // the order must not depend on the language the snapshot is read in.
        .sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || a.since.localeCompare(b.since))
    );
  }

  private async publish(snapshot: Snapshot, now: Date): Promise<void> {
    this.snapshotValue = snapshot;
    // The incident history (and the weekly report built from it) follows every run, notifications paused or not.
    this.incidents.record(snapshot.issues, now.getTime());
    // During maintenance nothing is sent; what is still broken afterwards goes out on the first run after it.
    if (this.settings.notificationsOn() && !snapshot.maintenanceUntil) {
      try {
        await this.notifier.update(snapshot, now);
      } catch (err) {
        // The snapshot is published; a notification that cannot be built or sent must not undo that.
        this.logger.error(`notifications failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  private record(now: Date, o: Overview): void {
    this.historyBuffer.push({
      t: now.getTime(),
      cpu: o.cpu && o.cpu.allocatableMilli > 0 ? o.cpu.usedMilli / o.cpu.allocatableMilli : null,
      memory: o.memory && o.memory.allocatable > 0 ? o.memory.used / o.memory.allocatable : null,
    });
    const keep = Math.ceil((6 * 3600) / this.config.intervalSeconds);
    if (this.historyBuffer.length > keep) {
      this.historyBuffer.splice(0, this.historyBuffer.length - keep);
    }
  }
}
