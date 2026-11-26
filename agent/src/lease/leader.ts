import { KubeError } from '../kube/kube-client';
import { Logger } from '../logger';

/** What the leader election needs from the API: get, create and a merge patch carrying the resourceVersion (409 on a race). */
export interface LeaseApi {
  get<T>(path: string): Promise<T>;
  create(path: string, body: unknown): Promise<void>;
  mergePatch(path: string, body: unknown): Promise<void>;
}

interface Lease {
  metadata: { resourceVersion?: string };
  spec?: {
    holderIdentity?: string | null;
    leaseDurationSeconds?: number;
    acquireTime?: string;
    renewTime?: string;
    leaseTransitions?: number;
  };
}

export interface LeaderOptions {
  namespace: string;
  name: string;
  /** This pod. */
  identity: string;
  /** How long a holder that stopped renewing keeps the lease (default 15 s). */
  durationSeconds?: number;
  /** Renew (holder) and retry (others) every this many ms (default 2 s). */
  retryMs?: number;
  now?(): number;
}

/**
 * Which pod is in charge during a rolling update: the one holding the
 * `coordination.k8s.io` Lease `kubernanny` in the agent's namespace. Only it
 * sends notifications, the weekly report and pushes, runs actions and
 * writes, and holds the relay connection; another pod answers reads and
 * refuses writes with 503 AGENT_HANDOVER, which the app retries.
 *
 * - The holder renews every `retryMs`; a pod that cannot renew for
 *   `durationSeconds` minus a margin stops acting before anyone else may start.
 * - Release on SIGTERM (`release()`): the holder is cleared, and the new pod
 *   takes over on its next try, within `retryMs`.
 * - A pod that dies without releasing loses the lease after `durationSeconds`.
 *   Expiry is judged by when this pod saw the record change (as client-go
 *   does), not by the other pod's clock.
 * - Every write carries the resourceVersion read: two pods racing for a free
 *   lease get one 409, and only one wins.
 */
export class LeaderElection {
  private leader = false;
  private stopped = true;
  private released = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private lastRenew = 0;
  private observed: { record: string; at: number } | null = null;
  private readonly listeners: ((leader: boolean) => void)[] = [];
  private readonly logger = new Logger('lease');
  private tick: Promise<void> = Promise.resolve();

  constructor(
    private readonly api: LeaseApi,
    private readonly options: LeaderOptions,
  ) {}

  private get path(): string {
    return `/apis/coordination.k8s.io/v1/namespaces/${encodeURIComponent(this.options.namespace)}/leases/${encodeURIComponent(this.options.name)}`;
  }

  private get duration(): number {
    return this.options.durationSeconds ?? 15;
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  isLeader(): boolean {
    if (this.leader && this.now() - this.lastRenew > (this.duration - 3) * 1000) {
      // Could not renew in time: someone else may hold it by now. Stop acting first.
      this.setLeader(false);
    }
    return this.leader;
  }

  /** Called with true when this pod takes over and false when it hands over or loses the lease. */
  onChange(listener: (leader: boolean) => void): void {
    this.listeners.push(listener);
  }

  start(): void {
    if (!this.stopped) {
      return;
    }
    this.stopped = false;
    this.schedule(0);
  }

  /** One round now (tests and the first start). */
  async tryNow(): Promise<boolean> {
    this.tick = this.tick
      .then(() => this.round())
      .catch((err: unknown) => this.logger.warn(`lease: ${err instanceof Error ? err.message : String(err)}`));
    await this.tick;
    return this.isLeader();
  }

  /** Stops trying and gives the lease up at once, so the next pod need not wait for it to expire. */
  async release(): Promise<void> {
    this.stopped = true;
    this.released = true;
    if (this.timer) {
      clearTimeout(this.timer);
    }
    await this.tick;
    if (!this.leader) {
      return;
    }
    this.setLeader(false);
    try {
      const lease = await this.api.get<Lease>(this.path);
      if (lease.spec?.holderIdentity === this.options.identity) {
        await this.api.mergePatch(this.path, {
          metadata: { resourceVersion: lease.metadata.resourceVersion },
          spec: { holderIdentity: null, leaseDurationSeconds: 1, renewTime: microTime(this.now()) },
        });
        this.logger.log('released');
      }
    } catch (err) {
      this.logger.warn(
        `could not release, it expires in ${this.duration}s: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private schedule(ms: number): void {
    if (this.stopped) {
      return;
    }
    this.timer = setTimeout(() => {
      void this.tryNow().then(() => this.schedule(this.options.retryMs ?? 2000));
    }, ms);
    this.timer.unref?.();
  }

  private async round(): Promise<void> {
    if (this.released) {
      return;
    }
    const now = this.now();
    const me = this.options.identity;
    let lease: Lease;
    try {
      lease = await this.api.get<Lease>(this.path);
    } catch (err) {
      if (err instanceof KubeError && err.status === 404) {
        await this.create(now);
        return;
      }
      throw err;
    }
    const spec = lease.spec ?? {};
    const record = JSON.stringify([spec.holderIdentity, spec.renewTime, spec.leaseTransitions]);
    if (this.observed?.record !== record) {
      this.observed = { record, at: now };
    }
    const holder = spec.holderIdentity || '';
    const expired = now - this.observed.at > (spec.leaseDurationSeconds ?? this.duration) * 1000;
    if (holder && holder !== me && !expired) {
      this.setLeader(false);
      return;
    }
    const taking = holder !== me;
    await this.api.mergePatch(this.path, {
      metadata: { resourceVersion: lease.metadata.resourceVersion },
      spec: {
        holderIdentity: me,
        leaseDurationSeconds: this.duration,
        renewTime: microTime(now),
        ...(taking ? { acquireTime: microTime(now), leaseTransitions: (spec.leaseTransitions ?? 0) + 1 } : {}),
      },
    });
    this.lastRenew = now;
    if (taking) {
      this.logger.log(holder ? `took over from ${holder}${expired ? ' (expired)' : ''}` : 'acquired');
    }
    this.setLeader(true);
  }

  private async create(now: number): Promise<void> {
    await this.api.create(
      `/apis/coordination.k8s.io/v1/namespaces/${encodeURIComponent(this.options.namespace)}/leases`,
      {
        apiVersion: 'coordination.k8s.io/v1',
        kind: 'Lease',
        metadata: { name: this.options.name, labels: { 'app.kubernetes.io/name': 'kubernanny' } },
        spec: {
          holderIdentity: this.options.identity,
          leaseDurationSeconds: this.duration,
          acquireTime: microTime(now),
          renewTime: microTime(now),
          leaseTransitions: 0,
        },
      },
    );
    this.lastRenew = now;
    this.logger.log('acquired (created the lease)');
    this.setLeader(true);
  }

  private setLeader(value: boolean): void {
    if (this.leader === value) {
      return;
    }
    this.leader = value;
    for (const listener of this.listeners) {
      try {
        listener(value);
      } catch (err) {
        this.logger.error(`listener failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
}

/** Always in charge: outside a pod, in the demo, in tests. */
export class SoleLeader {
  isLeader(): boolean {
    return true;
  }
  onChange(_listener: (leader: boolean) => void): void {
    // Never changes.
  }
  start(): void {
    // Nothing to elect.
  }
  async tryNow(): Promise<boolean> {
    return true;
  }
  async release(): Promise<void> {
    // Nothing to hand over.
  }
}

export type Leader = Pick<LeaderElection, 'isLeader' | 'onChange' | 'start' | 'release' | 'tryNow'>;

/** MicroTime as Kubernetes writes it: RFC 3339 with microseconds. */
function microTime(ms: number): string {
  return new Date(ms).toISOString().replace(/\.(\d{3})Z$/, '.$1000Z');
}
