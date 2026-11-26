import { createServer, Server } from 'node:http';

import { ActionsService } from './actions/actions.service';
import { RollbackApi, rollbackRoutes } from './actions/rollback.routes';
import { RollbackService } from './actions/rollback.service';
import { AppApi, appRoutes } from './app.routes';
import { DevicesService } from './auth/devices.service';
import { IdentityService } from './auth/identity.service';
import { principalOf } from './auth/principal';
import { CONFIG, Config, loadConfig } from './config';
import { DemoKubeClient } from './demo/demo-cluster';
import { E2eApi, e2eRoutes } from './e2e/e2e.routes';
import { E2eService } from './e2e/e2e.service';
import { InternalServer } from './e2e/internal-server';
import { HistoryStore } from './history/history-store';
import { HttpError } from './http/errors';
import { createHttpHandler, Reply, Route } from './http/server';
import { t } from './i18n/text';
import { IncidentsService } from './incidents/incidents.service';
import { KubeClient } from './kube/kube-client';
import { Leader, LeaderElection, SoleLeader } from './lease/leader';
import { Logger } from './logger';
import { AcceptanceApi, acceptanceRoutes } from './modules/vulnerabilities/acceptance.routes';
import { AcceptanceService } from './modules/vulnerabilities/acceptance.service';
import { NotifiedStore } from './notify/notified-store';
import { Notifier } from './notify/notifier';
import { PairingService } from './pairing/pairing';
import { AppPushService } from './push/app-push.service';
import { DeadmanService } from './push/deadman.service';
import { PushApi, pushRoutes } from './push/push.routes';
import { PushTransport } from './push/push-transport';
import { RelayClient } from './relay/relay-client';
import { SettingsService } from './settings/settings.service';
import { checkSwitchIds } from './settings/switch-ids';
import { SilenceService } from './silence/silence.service';
import { StatusService } from './status/status.service';

export interface AgentOptions {
  /** The cluster; default: the real API server, or the demo cluster with DEMO set. */
  kube?: KubeClient;
  /** Replaces the notifier everywhere (tests). */
  notifier?: Notifier;
  /** Default: read from the environment, with the hard switches checked. */
  config?: Config;
  /** Replaces the leader election (tests of the handover). */
  leader?: Leader;
}

type Class<T> = abstract new (...args: never[]) => T;

/**
 * The whole agent, wired by hand: every service once, in the order they need
 * each other. What NestJS's module did, without the framework: `init()` runs
 * the start-up steps (`onModuleInit`, then the internal socket, the relay,
 * push and the run loop), `close()` the shutdown.
 */
export class Agent {
  readonly config: Config;
  readonly kube: KubeClient;
  readonly identity: IdentityService;
  readonly devices: DevicesService;
  readonly internal: InternalServer;
  readonly incidents: IncidentsService;
  readonly pushTransport: PushTransport;
  readonly appPush: AppPushService;
  readonly deadman: DeadmanService;
  readonly notifiedStore: NotifiedStore;
  readonly notifier: Notifier;
  readonly settings: SettingsService;
  readonly silences: SilenceService;
  readonly acceptance: AcceptanceService;
  readonly pairing: PairingService;
  readonly e2e: E2eService;
  readonly relay: RelayClient;
  readonly status: StatusService;
  readonly actions: ActionsService;
  readonly rollbacks: RollbackService;
  /** The problem history and the own CPU and memory record in the ConfigMap `kubernanny-history`. */
  readonly history: HistoryStore;
  /** Which pod is in charge during a rolling update (POD_NAME set: a Lease; else always this one). */
  readonly leader: Leader;
  /** Every route the agent answers, public or guarded (`auth/public-routes.spec.ts` checks the public ones). */
  readonly routes: readonly Route[];
  readonly handler: ReturnType<typeof createHttpHandler>;
  private readonly registry = new Map<unknown, unknown>();
  private server: Server | null = null;
  private closed = false;
  private shuttingDown = false;
  private readonly startedAt = Date.now();
  private initialized = false;
  private readonly logger = new Logger('kubernanny');
  /** False from a takeover until devices and switches were read again successfully. */
  private stateCurrent = true;
  private followerRead: Promise<void> | null = null;

  constructor(options: AgentOptions = {}) {
    // Unknown module ids or action types in the hard switches stop the start (switch-ids.ts).
    const config = options.config ?? checkSwitchIds(loadConfig());
    this.config = config;
    // DEMO=1 (or broken | warning | healthy): a built-in made-up cluster, for trying Kubernanny without one.
    const kube = options.kube ?? (config.demo ? new DemoKubeClient(undefined, config.demo) : new KubeClient());
    this.kube = kube;
    this.leader =
      options.leader ??
      (config.podName && !config.demo
        ? new LeaderElection(kube, {
            namespace: config.namespace,
            name: config.leaseName ?? 'kubernanny',
            identity: config.podName,
          })
        : new SoleLeader());
    // In charge: holds the lease AND has read the stored state since taking it (fail closed after a handover).
    const isLeader = () => this.inCharge();
    this.identity = new IdentityService(config, kube);
    this.devices = new DevicesService(config, kube);
    this.internal = new InternalServer(config);
    this.incidents = new IncidentsService(kube);
    // Native push to the app through the relay (docs/NOTIFICATIONS.md); APP_PUSH=off refuses it entirely.
    this.pushTransport = new PushTransport();
    this.appPush = new AppPushService(config, this.devices, this.identity, this.pushTransport);
    this.notifiedStore = new NotifiedStore(config, kube);
    this.notifier = options.notifier ?? new Notifier(config, this.incidents, this.appPush, this.notifiedStore);
    this.deadman = new DeadmanService(config, this.devices, this.identity, this.pushTransport, this.appPush);
    this.notifier.deadman ??= this.deadman;
    this.settings = new SettingsService(config, kube, this.notifier);
    this.silences = new SilenceService(config, kube, this.notifier);
    this.acceptance = new AcceptanceService(config, kube, this.settings, this.notifier);
    this.pairing = new PairingService(config, this.identity);
    this.e2e = new E2eService(
      this.identity,
      this.devices,
      this.pairing,
      this.internal,
      config,
      this.notifier,
      isLeader,
    );
    this.relay = new RelayClient(config, this.identity, this.e2e, this.pushTransport);
    this.status = new StatusService(
      kube,
      config,
      this.notifier,
      this.settings,
      this.silences,
      this.incidents,
      this.acceptance,
    );
    this.actions = new ActionsService(kube, this.status, this.settings);
    this.rollbacks = new RollbackService(kube, this.settings, this.status, this.notifier);
    this.status.notifies = isLeader;
    this.history = new HistoryStore(config, kube, this.incidents, this.status.metrics, isLeader);
    this.status.afterRun = () => this.history.schedule();

    this.routes = [
      // Readiness, no data: ready once the first run is in memory (or READY_TIMEOUT_SECONDS passed), unready again on SIGTERM.
      {
        method: 'GET',
        path: '/readyz',
        public: true,
        handle: () =>
          this.ready()
            ? { ok: true }
            : new Reply(503, JSON.stringify({ ok: false }), 'application/json; charset=utf-8'),
      },
      ...appRoutes(
        new AppApi(
          this.status,
          this.actions,
          this.notifier,
          this.devices,
          this.identity,
          config,
          this.pairing,
          this.settings,
          this.relay,
          this.silences,
          this.incidents,
        ),
      ),
      ...e2eRoutes(new E2eApi(this.e2e, this.identity)),
      ...acceptanceRoutes(new AcceptanceApi(this.acceptance, this.status)),
      ...pushRoutes(new PushApi(this.appPush, config)),
      ...rollbackRoutes(new RollbackApi(this.rollbacks)),
    ];
    this.handler = createHttpHandler({
      routes: this.routes,
      // Every route needs a device proven by the end-to-end channel, unless it is public (fail closed).
      principal: (req) => principalOf(req, this.devices, config),
      language: config.language,
      corsOrigins: config.corsOrigins,
      webRoot: config.webRoot,
      isLeader,
      // A pod not in charge reads devices and switches again before every guarded call:
      // a device revoked on the pod in charge must not keep reading here during the overlap.
      beforeGuard: () => (this.inCharge() ? Promise.resolve() : this.refreshAsFollower()),
    });

    for (const [cls, value] of [
      [CONFIG, config],
      [KubeClient, kube],
      [IdentityService, this.identity],
      [DevicesService, this.devices],
      [InternalServer, this.internal],
      [IncidentsService, this.incidents],
      [PushTransport, this.pushTransport],
      [AppPushService, this.appPush],
      [NotifiedStore, this.notifiedStore],
      [Notifier, this.notifier],
      [SettingsService, this.settings],
      [SilenceService, this.silences],
      [AcceptanceService, this.acceptance],
      [PairingService, this.pairing],
      [E2eService, this.e2e],
      [RelayClient, this.relay],
      [StatusService, this.status],
      [ActionsService, this.actions],
      [RollbackService, this.rollbacks],
      [HistoryStore, this.history],
    ] as const) {
      this.registry.set(cls, value);
    }
  }

  /** A service by its class (or CONFIG), for tests and the bootstrap. */
  get<T>(key: Class<T> | symbol): T {
    if (!this.registry.has(key)) {
      throw new Error(`no such service: ${String((key as { name?: string }).name ?? key)}`);
    }
    return this.registry.get(key) as T;
  }

  /**
   * Loads the stored state (keys, devices, switches, silences), then starts
   * the socket, the run loop and the lease; the relay and push housekeeping
   * follow the lease (this pod in charge).
   */
  async init(): Promise<void> {
    await this.loadState();
    await this.internal.start(this.handler);
    this.status.onApplicationBootstrap();
    // The first answer decides whether this pod starts in charge; state loaded above is current then.
    const first = await this.leader.tryNow();
    if (first) {
      await this.takeCharge(false);
    }
    this.leader.onChange((leader) => {
      if (this.shuttingDown || this.closed) {
        return;
      }
      if (leader) {
        void this.takeCharge(true);
      } else {
        this.logger.warn('no longer in charge: notifications, actions and the relay stop here');
        this.relay.handOver();
      }
    });
    this.leader.start();
    this.initialized = true;
  }

  /** /readyz: the first run is in memory (or it took too long to wait for), and the pod is not shutting down. */
  ready(): boolean {
    if (this.shuttingDown || !this.initialized) {
      return false;
    }
    return this.status.ranOnce || Date.now() - this.startedAt > (this.config.readyTimeoutSeconds ?? 90) * 1000;
  }

  private async loadState(): Promise<void> {
    await Promise.all([
      // Before the first run and before anything is served: the history continues where the last pod left it.
      this.history.load(),
      this.identity.onModuleInit(),
      this.devices.onModuleInit(),
      this.settings.onModuleInit(),
      this.silences.onModuleInit(),
      this.acceptance.onModuleInit(),
    ]);
  }

  /**
   * This pod holds the lease. After a handover the other pod may have
   * written devices, switches or silences since this one started: read them
   * again before acting. The notifier reads what was already sent on its
   * first send (NotifiedStore), so nothing goes out twice.
   */
  private async takeCharge(takeover: boolean): Promise<void> {
    if (takeover) {
      // Fail closed: until devices and switches are read again, this pod holds the lease but acts on
      // nothing (writes 503, no notifications, no relay). It retries every 2 s while it holds the lease.
      this.stateCurrent = false;
      this.logger.log('in charge now: reloading stored state');
      for (;;) {
        if (!this.leader.isLeader() || this.shuttingDown || this.closed) {
          return;
        }
        try {
          await Promise.all([this.devices.reload(), this.settings.reload()]);
          // Silences and acceptances only quiet issues; their loaders keep the last state on a failed read.
          await Promise.all([this.silences.onModuleInit(), this.acceptance.onModuleInit()]);
          break;
        } catch (err) {
          this.logger.warn(
            `reloading devices and switches failed, not acting yet: ${err instanceof Error ? err.message : String(err)}`,
          );
          await new Promise((resolve) => setTimeout(resolve, 2000).unref());
        }
      }
      this.stateCurrent = true;
      // What the previous pod wrote last (its SIGTERM flush) joins this pod's own record; never blocks the takeover.
      await this.history.takeOver();
    }
    await this.appPush.onApplicationBootstrap();
    this.relay.onApplicationBootstrap();
  }

  /** Holds the lease and has current state: may write, notify and hold the relay. */
  inCharge(): boolean {
    return this.stateCurrent && this.leader.isLeader();
  }

  /**
   * Before a guarded call on a pod that is not in charge: devices and
   * switches read again (calls arriving together share one read). A failed
   * read answers 503 AGENT_HANDOVER, never with the state read at start.
   */
  private async refreshAsFollower(): Promise<void> {
    this.followerRead ??= Promise.all([this.devices.reload(), this.settings.reload()])
      .then(() => undefined)
      .finally(() => {
        this.followerRead = null;
      });
    try {
      await this.followerRead;
    } catch (err) {
      this.logger.warn(`not in charge and cannot read devices: ${err instanceof Error ? err.message : String(err)}`);
      throw new HttpError({ code: 'AGENT_HANDOVER', message: t('error.agentHandover') }, 503);
    }
  }

  /**
   * SIGTERM: unready at once, the history written one last time, and out of
   * charge (the lease is released, the
   * relay connection closed with 1001), so the new pod takes over within
   * seconds; the watches and timers stop. The listener keeps answering for
   * SHUTDOWN_DELAY_SECONDS while the endpoints are removed, then closes and
   * lets requests in flight finish (at most `drainMs`).
   */
  async shutdown(drainMs = 10_000): Promise<void> {
    if (this.shuttingDown) {
      return;
    }
    this.shuttingDown = true;
    this.logger.log('shutting down: handing over');
    this.relay.handOver();
    this.status.onApplicationShutdown();
    // The last write of the history, while this pod still holds the lease (at most 5 s).
    await this.history.flush();
    await this.leader.release();
    await new Promise((resolve) => setTimeout(resolve, (this.config.shutdownDelaySeconds ?? 5) * 1000));
    const server = this.server;
    if (server?.listening) {
      const closed = new Promise<void>((resolve) => server.close(() => resolve()));
      server.closeIdleConnections();
      const timer = setTimeout(() => server.closeAllConnections(), drainMs);
      await closed;
      clearTimeout(timer);
    }
    await this.close();
  }

  /** The public port's server (not listening until `listen`); supertest takes it as it is. */
  getHttpServer(): Server {
    this.server ??= createServer(this.handler);
    return this.server;
  }

  async listen(port: number, host: string): Promise<void> {
    const server = this.getHttpServer();
    await new Promise<void>((resolve, reject) => server.once('error', reject).listen(port, host, () => resolve()));
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    const wasShuttingDown = this.shuttingDown;
    this.shuttingDown = true;
    if (!wasShuttingDown) {
      this.status.onApplicationShutdown();
      await this.history.flush();
    }
    await this.leader.release();
    this.relay.onModuleDestroy();
    await this.internal.close();
    this.status.onApplicationShutdown();
    const server = this.server;
    if (server?.listening) {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeIdleConnections();
      });
    }
  }
}
