import { Logger } from '../logger';
import { Issue } from '../checks/types';
import type { Config } from '../config';
import { Detected, discover, distribution } from '../discovery/discovery';
import { ClusterCache } from '../inventory/cluster-cache';
import { Inventory, emptyInventory, gatherInventory } from '../inventory/inventory';
import { errorText, raw, t } from '../i18n/text';
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
import { AGENT_BUILD, AGENT_COMMIT, AGENT_VERSION } from '../version';
import { runTiming } from './run-timing';
import { mergeIssues, runComponent, runCoreCheck } from './run-modules';
import { dedupeAlerts } from '../modules/core/standard-alerts/alertmanager-dedupe';
import { buildOverview, HistoryPoint, IssueView, lightFor, Overview, scoreFor, SEVERITY_RANK, Snapshot } from './snapshot';

// The types and rules of a snapshot live in snapshot.ts; existing imports keep working through here.
export * from './snapshot';

/** The synthetic issue raised while the agent cannot read the cluster. */
export const UNREACHABLE_ISSUE_ID = 'agent/cluster-unreachable';
/** One failed run is a blip (an API server restart); this many in a row are an outage worth a red light and a notification. */
export const UNREACHABLE_AFTER_RUNS = 3;
/** A relevant change (a pod into CrashLoopBackOff, a node NotReady) starts a run after this quiet time … */
export const EARLY_RUN_DEBOUNCE_MS = 3_000;
/** … but never sooner than this after the previous run started, so a rollout of fifty pods costs a few runs, not fifty. */
export const EARLY_RUN_MIN_GAP_MS = 15_000;

export class StatusService {
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
  /** The watches behind the inventory; null where the client cannot watch (demo, tests). */
  readonly cache: ClusterCache | null;
  private earlyTimer: ReturnType<typeof setTimeout> | null = null;
  /** When the pending early run fires; null without one. */
  private earlyAt: number | null = null;
  /** When the interval timer was started: its ticks are this plus whole intervals. */
  private intervalSince: number | null = null;
  private lastRunStarted = 0;
  private stopped = false;
  /** True once the first run has finished, good or failed: what /readyz waits for. */
  ranOnce = false;
  /**
   * Whether this pod sends notifications (it holds the lease, lease/leader.ts).
   * The pod that does not still runs its checks, so it is ready to take over
   * with a current snapshot; it only keeps quiet.
   */
  notifies: () => boolean = () => true;

  constructor(
    private readonly kube: KubeClient,
    private readonly config: Config,
    private readonly notifier: Notifier,
    private readonly settings: SettingsService,
    private readonly silences: SilenceService,
    private readonly incidents: IncidentsService,
    /** Advisories marked as not applicable; absent where nobody wires it (they then all count). */
    private readonly acceptance?: AcceptanceService,
  ) {
    // A switch in the app takes effect at once, not with the next run.
    settings.onChange(() => void this.refreshAfterChange());
    this.snapshotValue = this.emptySnapshot();
    this.vulnDb = vulnDbFor(kube, config);
    this.cache = kube.supportsWatch ? new ClusterCache(kube, { onRelevantChange: () => this.requestEarlyRun() }) : null;
  }

  onApplicationBootstrap(): void {
    // The first run waits for the first lists of the watches (at most 20 s), so it reads from memory.
    this.cache?.start();
    void (this.cache ? this.cache.ready() : Promise.resolve()).then(() => {
      if (!this.stopped) {
        void this.refresh();
        this.timer = setInterval(() => void this.refresh(), this.config.intervalSeconds * 1000);
        this.intervalSince = Date.now();
      }
    });
  }

  onApplicationShutdown(): void {
    this.stopped = true;
    clearInterval(this.timer);
    if (this.earlyTimer) {
      clearTimeout(this.earlyTimer);
      this.earlyTimer = null;
      this.earlyAt = null;
    }
    this.cache?.stop();
  }

  /**
   * A watch saw a change that can open or close an issue: run soon instead
   * of at the next interval, debounced. Notifications keep their own rules
   * (NOTIFY_AFTER_SECONDS, sent once), so an early run only shows the app
   * the change sooner. Not while the cluster cannot be read: the
   * unreachable count is per run.
   */
  requestEarlyRun(): void {
    if (this.stopped || this.earlyTimer || this.failures > 0) {
      return;
    }
    const wait = Math.max(EARLY_RUN_DEBOUNCE_MS, this.lastRunStarted + EARLY_RUN_MIN_GAP_MS - Date.now());
    this.earlyAt = Date.now() + wait;
    this.earlyTimer = setTimeout(() => {
      this.earlyTimer = null;
      this.earlyAt = null;
      void this.refresh();
    }, wait);
    this.earlyTimer.unref?.();
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
        this.ranOnce = true;
      });
    return this.running;
  }

  /** A run that starts after now: a change (switch, silence) must not land in a run already under way. */
  refreshAfterChange(): Promise<void> {
    return this.running ? this.running.then(() => this.refresh()) : this.refresh();
  }

  snapshot(): Snapshot {
    const next = this.nextCheckAt(Date.now());
    return next === null ? this.snapshotValue : { ...this.snapshotValue, nextCheckAt: new Date(next).toISOString() };
  }

  /** The next scheduled run in ms: the next interval tick, or a pending early run if that comes first. */
  nextCheckAt(now: number): number | null {
    return this.stopped ? null : nextRunAt(now, this.intervalSince, this.config.intervalSeconds * 1000, this.earlyAt);
  }

  state(): { inv: Inventory; detected: Detected[]; data: RunData; prom: Prometheus | null } {
    return { inv: this.inventory, detected: this.detected, data: this.runData, prom: this.promClient };
  }

  /** CPU and memory share of the whole cluster, one point per run, from metrics-server. */
  history(): HistoryPoint[] {
    return this.historyBuffer;
  }

  findIssue(id: string): Issue | undefined {
    return this.snapshotValue.issues.find((i) => i.id === id) ?? this.pendingSyncIssue(id);
  }

  /**
   * An app ready to sync is no issue, but its sync runs like one: under the
   * id it had as an issue, with the target taken from this run's list, never
   * from the request.
   */
  private pendingSyncIssue(id: string): Issue | undefined {
    const pending = this.snapshotValue.modules.flatMap((m) => m.pendingSyncs ?? []).find((p) => p.id === id && p.canSync);
    return pending
      ? { id, check: 'argocd', severity: 'info', title: raw(pending.app), cause: raw(''), actions: [{ type: 'argocd-sync', namespace: pending.namespace, app: pending.app }] }
      : undefined;
  }

  private emptySnapshot(): Snapshot {
    return {
      cluster: this.config.clusterName,
      agentVersion: AGENT_VERSION,
      ...(AGENT_BUILD ? { agentBuild: AGENT_BUILD } : {}),
      ...(AGENT_COMMIT ? { agentCommit: AGENT_COMMIT } : {}),
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
    this.lastRunStarted = started;
    let inv: Inventory;
    try {
      inv = await gatherInventory(this.kube, now, { cache: this.cache, previous: this.snapshotValue.checkedAt ? this.inventory : null });
    } catch (err) {
      await this.publish(this.failedSnapshot(err, now), now);
      return;
    }
    this.failures = 0;
    this.failingSince = null;
    await this.publish(await this.buildSnapshot(inv, now, started, Date.now() - started), now);
  }

  /** The snapshot of a run that read the cluster: every enabled module, merged, ordered and judged. */
  private async buildSnapshot(inv: Inventory, now: Date, started: number, inventoryMs = 0): Promise<Snapshot> {
    const detected = discover(inv, this.config.customComponents);
    const data: RunData = {};
    const base = { inv, kube: this.kube, config: this.config, now, data };
    const prom = findPrometheus(base, detected);
    const ctx: ModuleContext = { ...base, prom, detected, vulnDb: this.vulnDb, vulnAcceptance: this.acceptance?.state(now.getTime()), rollbackOn: this.settings.actionOn('argocd-rollback'), syncOn: this.settings.actionOn('argocd-sync') };
    const allowed = this.settings.actionOn;

    // Components first: some fill RunData the core checks read (kured lock, certificates).
    const moduleMs = new Map<string, number>();
    const timed = async <T>(id: string, fn: () => Promise<T>): Promise<T> => {
      const t0 = Date.now();
      try {
        return await fn();
      } finally {
        moduleMs.set(id, Date.now() - t0);
      }
    };
    const t0 = Date.now();
    const components = await Promise.all(
      detected
        .filter((d) => this.settings.moduleOn(d.entry.id))
        .map((d) => timed(d.entry.id, () => runComponent(ctx, d, INTEGRATIONS.find((i) => i.id === d.entry.id), allowed))),
    );
    const t1 = Date.now();
    const core = await Promise.all(CORE_CHECKS.filter((m) => this.settings.moduleOn(m.id)).map((m) => timed(m.id, () => runCoreCheck(ctx, m, allowed))));
    const t2 = Date.now();
    const byId = mergeIssues(core, components);
    // An Alertmanager alert that is the same as a built-in issue shows once, as the built-in one.
    dedupeAlerts(byId, [...core, ...components].map((o) => o.view), data, inv);
    const issues = this.withHistory([...byId.values()], now);
    const modules = [...core, ...components].map((a) => a.view);
    // How this run spent its time, on Kubernanny's own sheet: why a run takes a second on a real cluster.
    const own = modules.find((m) => m.id === 'kubernanny');
    if (own) {
      own.details = [
        ...runTiming({ inventoryMs, componentsMs: t1 - t0, coreMs: t2 - t1, totalMs: Date.now() - started, moduleMs, prometheus: prom?.timings ?? null }),
        ...(own.details ?? []),
      ];
    }
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
      ...(AGENT_BUILD ? { agentBuild: AGENT_BUILD } : {}),
      ...(AGENT_COMMIT ? { agentCommit: AGENT_COMMIT } : {}),
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
    if (this.notifies() && this.settings.notificationsOn() && !snapshot.maintenanceUntil) {
      try {
        await this.notifier.update(snapshot, now);
      } catch (err) {
        // The snapshot is published; a notification that cannot be built or sent must not undo that.
        this.logger.error(`notifications failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    // The widgets' hourly state, after the run's own messages; maintenance does not stop it (it shows nothing).
    if (this.notifies() && this.settings.notificationsOn()) {
      await this.notifier.refreshWidgets(snapshot);
    }
  }

  private record(now: Date, o: Overview): void {
    // One point per interval: early runs (after a watch event) would otherwise shorten the six hours the buffer covers.
    const last = this.historyBuffer.at(-1);
    if (last && now.getTime() - last.t < this.config.intervalSeconds * 900) {
      return;
    }
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

/**
 * The next run: the interval timer's next tick after `now` (it ticks at
 * `since` plus whole intervals), or a pending early run when that is sooner.
 * Null before the timer runs and without an early run.
 */
export function nextRunAt(now: number, since: number | null, intervalMs: number, earlyAt: number | null): number | null {
  if (since === null) {
    return earlyAt;
  }
  const tick = since + Math.max(1, Math.ceil((now - since) / intervalMs + 1e-9)) * intervalMs;
  return earlyAt !== null ? Math.min(earlyAt, tick) : tick;
}
