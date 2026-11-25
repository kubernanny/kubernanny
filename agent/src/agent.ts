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
import { Route, createHttpHandler } from './http/server';
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
  /** Every route the agent answers, public or guarded (`auth/public-routes.spec.ts` checks the public ones). */
  readonly routes: readonly Route[];
  readonly handler: ReturnType<typeof createHttpHandler>;
  private readonly registry = new Map<unknown, unknown>();
  private server: Server | null = null;
  private closed = false;

  constructor(options: AgentOptions = {}) {
    // Unknown module ids or action types in the hard switches stop the start (switch-ids.ts).
    const config = options.config ?? checkSwitchIds(loadConfig());
    this.config = config;
    // DEMO=1 (or broken | warning | healthy): a built-in made-up cluster, for trying Kubernanny without one.
    const kube = options.kube ?? (config.demo ? new DemoKubeClient(undefined, config.demo) : new KubeClient());
    this.kube = kube;
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
    this.e2e = new E2eService(this.identity, this.devices, this.pairing, this.internal, config, this.notifier);
    this.relay = new RelayClient(config, this.identity, this.e2e, this.pushTransport);
    this.status = new StatusService(kube, config, this.notifier, this.settings, this.silences, this.incidents, this.acceptance);
    this.actions = new ActionsService(kube, this.status, this.settings);
    this.rollbacks = new RollbackService(kube, this.settings, this.status, this.notifier);

    this.routes = [
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

  /** Loads the stored state (keys, devices, switches, silences), then starts the socket, the relay, push and the run loop. */
  async init(): Promise<void> {
    await Promise.all([this.identity.onModuleInit(), this.devices.onModuleInit(), this.settings.onModuleInit(), this.silences.onModuleInit(), this.acceptance.onModuleInit()]);
    await this.internal.start(this.handler);
    this.relay.onApplicationBootstrap();
    await this.appPush.onApplicationBootstrap();
    this.status.onApplicationBootstrap();
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
