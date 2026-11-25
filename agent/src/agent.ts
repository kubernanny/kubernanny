import { Server, createServer } from 'node:http';
import { ActionsService } from './actions/actions.service';
import { RollbackController, rollbackRoutes } from './actions/rollback.controller';
import { RollbackService } from './actions/rollback.service';
import { AppController, appRoutes } from './app.controller';
import { DevicesService } from './auth/devices.service';
import { IdentityService } from './auth/identity.service';
import { principalOf } from './auth/principal.guard';
import { CONFIG, Config, loadConfig } from './config';
import { DemoKubeClient } from './demo/demo-cluster';
import { E2eController, e2eRoutes } from './e2e/e2e.controller';
import { E2eService } from './e2e/e2e.service';
import { InternalServer } from './e2e/internal-server';
import { Reply, Route, createHttpHandler } from './http/server';
import { Leader, LeaderElection, SoleLeader } from './lease/leader';
import { Logger } from './logger';
import { IncidentsService } from './incidents/incidents.service';
import { KubeClient } from './kube/kube-client';
import { AcceptanceController, acceptanceRoutes } from './modules/vulnerabilities/acceptance.controller';
import { AcceptanceService } from './modules/vulnerabilities/acceptance.service';
import { NotifiedStore } from './notify/notified-store';
import { Notifier } from './notify/notifier';
import { PairingService } from './pairing/pairing';
import { AppPushService } from './push/app-push.service';
import { PushController, pushRoutes } from './push/push.controller';
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

  constructor(options: AgentOptions = {}) {
    // Unknown module ids or action types in the hard switches stop the start (switch-ids.ts).
    const config = options.config ?? checkSwitchIds(loadConfig());
    this.config = config;
    // DEMO=1 (or broken | warning | healthy): a built-in made-up cluster, for trying Kubernanny without one.
    const kube = options.kube ?? (config.demo ? new DemoKubeClient(undefined, config.demo) : new KubeClient());
    this.kube = kube;
    this.leader = options.leader ?? (config.podName && !config.demo ? new LeaderElection(kube, { namespace: config.namespace, name: config.leaseName ?? 'kubernanny', identity: config.podName }) : new SoleLeader());
    const isLeader = () => this.leader.isLeader();
    this.identity = new IdentityService(config, kube);
    this.devices = new DevicesService(config, kube);
    this.internal = new InternalServer(config);
    this.incidents = new IncidentsService(kube);
    // Native push to the app through the relay (docs/NOTIFICATIONS.md); APP_PUSH=off refuses it entirely.
    this.pushTransport = new PushTransport();
    this.appPush = new AppPushService(config, this.devices, this.identity, this.pushTransport);
    this.notifiedStore = new NotifiedStore(config, kube);
    this.notifier = options.notifier ?? new Notifier(config, this.incidents, this.appPush, this.notifiedStore);
    this.settings = new SettingsService(config, kube, this.notifier);
    this.silences = new SilenceService(config, kube, this.notifier);
    this.acceptance = new AcceptanceService(config, kube, this.settings, this.notifier);
    this.pairing = new PairingService(config, this.identity);
    this.e2e = new E2eService(this.identity, this.devices, this.pairing, this.internal, config, this.notifier, isLeader);
    this.relay = new RelayClient(config, this.identity, this.e2e, this.pushTransport);
    this.status = new StatusService(kube, config, this.notifier, this.settings, this.silences, this.incidents, this.acceptance);
    this.actions = new ActionsService(kube, this.status, this.settings);
    this.rollbacks = new RollbackService(kube, this.settings, this.status, this.notifier);
    this.status.notifies = isLeader;

    this.routes = [
      // Readiness, no data: ready once the first run is in memory (or READY_TIMEOUT_SECONDS passed), unready again on SIGTERM.
      { method: 'GET', path: '/readyz', public: true, handle: () => (this.ready() ? { ok: true } : new Reply(503, JSON.stringify({ ok: false }), 'application/json; charset=utf-8')) },
      ...appRoutes(new AppController(this.status, this.actions, this.notifier, this.devices, this.identity, config, this.pairing, this.settings, this.relay, this.silences, this.incidents)),
      ...e2eRoutes(new E2eController(this.e2e, this.identity)),
      ...acceptanceRoutes(new AcceptanceController(this.acceptance, this.status)),
      ...pushRoutes(new PushController(this.appPush, config)),
      ...rollbackRoutes(new RollbackController(this.rollbacks)),
    ];
    this.handler = createHttpHandler({
      routes: this.routes,
      // Every route needs a device proven by the end-to-end channel, unless it is public (fail closed).
      principal: (req) => principalOf(req, this.devices, config),
      language: config.language,
      corsOrigins: config.corsOrigins,
      webRoot: config.webRoot,
      isLeader,
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
    await Promise.all([this.identity.onModuleInit(), this.devices.onModuleInit(), this.settings.onModuleInit(), this.silences.onModuleInit(), this.acceptance.onModuleInit()]);
  }

  /**
   * This pod holds the lease. After a handover the other pod may have
   * written devices, switches or silences since this one started: read them
   * again before acting. The notifier reads what was already sent on its
   * first send (NotifiedStore), so nothing goes out twice.
   */
  private async takeCharge(takeover: boolean): Promise<void> {
    if (takeover) {
      this.logger.log('in charge now: reloading stored state');
      try {
        await Promise.all([this.devices.onModuleInit(), this.settings.onModuleInit(), this.silences.onModuleInit(), this.acceptance.onModuleInit()]);
      } catch (err) {
        this.logger.warn(`reloading state failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    await this.appPush.onApplicationBootstrap();
    this.relay.onApplicationBootstrap();
  }

  /**
   * SIGTERM: unready at once and out of charge (the lease is released, the
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
    this.shuttingDown = true;
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
