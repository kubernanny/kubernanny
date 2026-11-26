import { servicePort } from '../discovery/discovery';
import { Service } from '../inventory/inventory';
import { KubeClient } from '../kube/kube-client';
import { readCapped } from '../util/read-capped';
import { list, num, record, str, strings } from './untrusted';

/**
 * Reaches an in-cluster HTTP service. Inside the cluster directly over its DNS
 * name (no RBAC needed, NetworkPolicies apply). Outside, during development
 * with `kubectl proxy`, through the API server's service proxy
 * (`…/services/<name>:<port>/proxy/…`).
 */
export class ServiceHttp {
  constructor(
    private readonly kube: KubeClient,
    private readonly base: string,
  ) {}

  static forService(kube: KubeClient, svc: Service, prefer: (number | string)[]): ServiceHttp | null {
    const port = servicePort(svc, prefer);
    if (!port) {
      return null;
    }
    const namespace = svc.metadata.namespace ?? 'default';
    if (kube.inCluster) {
      return new DirectHttp(kube, `http://${svc.metadata.name}.${namespace}.svc:${port}`);
    }
    return new ServiceHttp(
      kube,
      `/api/v1/namespaces/${encodeURIComponent(namespace)}/services/${encodeURIComponent(svc.metadata.name)}:${port}/proxy`,
    );
  }

  /** A direct URL (e.g. PROMETHEUS_URL) instead of the proxy. */
  static direct(kube: KubeClient, url: string): ServiceHttp {
    return new DirectHttp(kube, url.replace(/\/$/, ''));
  }

  get<T>(path: string): Promise<T> {
    return this.kube.get<T>(`${this.base}${path}`);
  }

  text(path: string): Promise<string> {
    return this.kube.text(`${this.base}${path}`);
  }
}

/** In-cluster services answer with a few KB; anything far beyond that is refused rather than buffered. */
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

export { readCapped };

class DirectHttp extends ServiceHttp {
  constructor(
    kube: KubeClient,
    private readonly url: string,
  ) {
    super(kube, '');
  }

  // GET only, no credentials sent, no redirects followed (a redirect could
  // point anywhere), bounded in time and size.
  override async get<T>(path: string): Promise<T> {
    return JSON.parse(await this.text(path)) as T;
  }

  override async text(path: string): Promise<string> {
    const res = await fetch(`${this.url}${path}`, {
      method: 'GET',
      redirect: 'error',
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      throw new Error(`${res.status} from ${this.url}${path}`);
    }
    return readCapped(res, MAX_RESPONSE_BYTES);
  }
}

export interface PromSample {
  metric: Record<string, string>;
  value: number;
}

export interface PromSeries {
  metric: Record<string, string>;
  points: [number, number][];
}

/** Series one query may return; a homelab's queries stay far below, a forged answer is cut here. */
const MAX_PROM_SERIES = 10_000;
/** Points per series of a range query (168 h at a 5 min step is ~2000). */
const MAX_PROM_POINTS = 5_000;

/** The result list of a Prometheus answer: anything can answer on its port, so nothing in it is taken on trust. */
function promResult(answer: unknown): unknown[] {
  const res = record(answer);
  if (res.status !== 'success') {
    throw new Error(typeof res.error === 'string' ? res.error.slice(0, 200) : 'Prometheus query failed');
  }
  return list(record(res.data).result, MAX_PROM_SERIES);
}

/** Queries one run sends to Prometheus at the same time; the rest wait their turn (the API server proxies them all). */
export const PROM_CONCURRENCY = 8;

export class Prometheus {
  /** Every query of this run with how long it took, for the run's timing on the Kubernanny sheet. */
  readonly timings: { expr: string; ms: number }[] = [];
  private active = 0;
  private readonly waiting: (() => void)[] = [];

  constructor(private readonly http: ServiceHttp) {}

  private async slot<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= PROM_CONCURRENCY) {
      // Woken by a finishing query, which hands its slot over: the count stays.
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    } else {
      this.active++;
    }
    try {
      return await fn();
    } finally {
      const next = this.waiting.shift();
      if (next) {
        next();
      } else {
        this.active--;
      }
    }
  }

  async query(expr: string): Promise<PromSample[]> {
    const started = Date.now();
    const answer = await this.slot(() =>
      this.http.get<unknown>(`/api/v1/query?query=${encodeURIComponent(expr)}`),
    ).finally(() => {
      // The client outlives its run (the history views use it until the next one): keep the list bounded.
      if (this.timings.length < 500) {
        this.timings.push({ expr, ms: Date.now() - started });
      }
    });
    const result = promResult(answer);
    return result
      .map((r) => ({ metric: strings(record(r).metric), value: num(list(record(r).value, 2)[1]) ?? NaN }))
      .filter((s) => Number.isFinite(s.value));
  }

  /** Scrape targets that are down, with Prometheus' last error and scrape time (`/api/v1/targets`). */
  async downTargets(): Promise<{ job: string; instance: string; lastError: string; lastScrape?: string }[]> {
    const res = record(await this.http.get<unknown>('/api/v1/targets?state=active'));
    if (res.status !== 'success') {
      throw new Error('Prometheus targets failed');
    }
    return list(record(res.data).activeTargets, MAX_PROM_SERIES)
      .map((x) => record(x))
      .filter((x) => x.health === 'down')
      .map((x) => {
        const labels = strings(x.labels);
        return {
          job: labels.job ?? str(x.scrapePool) ?? '?',
          instance: labels.instance ?? str(x.scrapeUrl) ?? '?',
          lastError: str(x.lastError) ?? '',
          lastScrape: str(x.lastScrape, 64),
        };
      });
  }

  async scalar(expr: string): Promise<number | null> {
    const [first] = await this.query(expr);
    return first ? first.value : null;
  }

  async range(expr: string, start: Date, end: Date, stepSeconds: number): Promise<PromSeries[]> {
    const params = new URLSearchParams({
      query: expr,
      start: String(Math.floor(start.getTime() / 1000)),
      end: String(Math.floor(end.getTime() / 1000)),
      step: String(stepSeconds),
    });
    const result = promResult(await this.http.get<unknown>(`/api/v1/query_range?${params}`));
    return result.map((r) => ({
      metric: strings(record(r).metric),
      points: list(record(r).values, MAX_PROM_POINTS)
        .map((p) => {
          const [t, v] = list(p, 2);
          return [(num(t) ?? NaN) * 1000, num(v) ?? NaN] as [number, number];
        })
        .filter(([t, v]) => Number.isFinite(t) && Number.isFinite(v)),
    }));
  }
}
