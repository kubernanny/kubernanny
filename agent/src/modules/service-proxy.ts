import { Service } from '../inventory/inventory';
import { KubeClient } from '../kube/kube-client';
import { servicePort } from '../discovery/discovery';

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
    return new ServiceHttp(kube, `/api/v1/namespaces/${encodeURIComponent(namespace)}/services/${encodeURIComponent(svc.metadata.name)}:${port}/proxy`);
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
export const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

/** Reads a response body, aborting once it passes `max` bytes. */
export async function readCapped(res: Response, max = MAX_RESPONSE_BYTES): Promise<string> {
  const declared = Number(res.headers.get('content-length') ?? '0');
  if (declared > max) {
    throw new Error(`response of ${declared} bytes refused (limit ${max})`);
  }
  if (!res.body) {
    return '';
  }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    size += value.byteLength;
    if (size > max) {
      await reader.cancel();
      throw new Error(`response passed ${max} bytes, refused`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

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
    const res = await fetch(`${this.url}${path}`, { method: 'GET', redirect: 'error', signal: AbortSignal.timeout(10_000) });
    if (!res.ok) {
      throw new Error(`${res.status} from ${this.url}${path}`);
    }
    return readCapped(res);
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

interface PromResponse<T> {
  status: string;
  data: { resultType: string; result: T[] };
  error?: string;
}

export class Prometheus {
  constructor(private readonly http: ServiceHttp) {}

  async query(expr: string): Promise<PromSample[]> {
    const res = await this.http.get<PromResponse<{ metric: Record<string, string>; value: [number, string] }>>(
      `/api/v1/query?query=${encodeURIComponent(expr)}`,
    );
    if (res.status !== 'success') {
      throw new Error(res.error ?? 'Prometheus query failed');
    }
    return res.data.result.map((r) => ({ metric: r.metric, value: Number(r.value[1]) })).filter((s) => Number.isFinite(s.value));
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
    const res = await this.http.get<PromResponse<{ metric: Record<string, string>; values: [number, string][] }>>(
      `/api/v1/query_range?${params}`,
    );
    if (res.status !== 'success') {
      throw new Error(res.error ?? 'Prometheus query failed');
    }
    return res.data.result.map((r) => ({
      metric: r.metric,
      points: r.values.map(([t, v]) => [t * 1000, Number(v)] as [number, number]).filter(([, v]) => Number.isFinite(v)),
    }));
  }
}
