import { readFileSync } from 'node:fs';
import { connect } from 'node:tls';
import { Injectable } from '@nestjs/common';

const SA_DIR = '/var/run/secrets/kubernetes.io/serviceaccount';

export class KubeError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/**
 * The few calls the agent needs, as plain fetch against the API server: no
 * client library, so nothing to keep in step with Kubernetes versions.
 *
 * In the cluster it uses the ServiceAccount token (read on every call, it is
 * rotated) and the cluster CA through NODE_EXTRA_CA_CERTS (set in the chart).
 * Locally, run `kubectl proxy` and set K8S_API_URL=http://127.0.0.1:8001.
 */
@Injectable()
export class KubeClient {
  private readonly baseUrl =
    process.env.K8S_API_URL ??
    `https://${process.env.KUBERNETES_SERVICE_HOST}:${process.env.KUBERNETES_SERVICE_PORT ?? '443'}`;

  /**
   * True inside a pod: services are then reached directly over cluster DNS,
   * not through the API server's service proxy (which would need a
   * cluster-wide `services/proxy` grant reaching every internal service).
   */
  get inCluster(): boolean {
    return !process.env.K8S_API_URL && Boolean(process.env.KUBERNETES_SERVICE_HOST);
  }

  /**
   * Expiry of the API server's serving certificate, read from the TLS
   * handshake (verified against the cluster CA). Null outside a cluster.
   */
  apiServerCertificate(): Promise<Date | null> {
    if (!this.inCluster) {
      return Promise.resolve(null);
    }
    return new Promise((resolve) => {
      const socket = connect(
        { host: process.env.KUBERNETES_SERVICE_HOST, port: Number(process.env.KUBERNETES_SERVICE_PORT ?? 443), servername: 'kubernetes.default.svc', timeout: 5000 },
        () => {
          const cert = socket.getPeerCertificate();
          socket.end();
          resolve(cert?.valid_to ? new Date(cert.valid_to) : null);
        },
      );
      socket.on('error', () => resolve(null));
      socket.on('timeout', () => {
        socket.destroy();
        resolve(null);
      });
    });
  }

  /** Items of a list, or null when the resource type does not exist (CRD not installed). */
  async list<T>(path: string): Promise<T[] | null> {
    const res = await this.request(path);
    if (res.status === 404) {
      return null;
    }
    await this.assertOk(res, path);
    const body = (await res.json()) as { items?: T[] };
    return body.items ?? [];
  }

  /**
   * One page of a list (`limit`/`continue` in `path`), or null when the
   * resource type does not exist. Public so test clients can delegate it.
   */
  async listPage<T>(path: string): Promise<{ items: T[]; continue?: string } | null> {
    const res = await this.request(path);
    if (res.status === 404) {
      return null;
    }
    await this.assertOk(res, path);
    const body = (await res.json()) as { items?: T[]; metadata?: { continue?: string } };
    return { items: body.items ?? [], continue: body.metadata?.continue || undefined };
  }

  /**
   * Pages through a list and hands each page to `each`, so a module can keep
   * a small digest of thousands of large objects (vulnerability reports)
   * instead of holding all of them at once. Stops after `maxItems`. False when
   * the resource type does not exist.
   */
  async listEach<T>(path: string, each: (items: T[]) => void, { pageSize = 100, maxItems = 5000 }: { pageSize?: number; maxItems?: number } = {}): Promise<boolean> {
    let token: string | undefined;
    let seen = 0;
    do {
      const query = `limit=${pageSize}${token ? `&continue=${encodeURIComponent(token)}` : ''}`;
      const page = await this.listPage<T>(`${path}${path.includes('?') ? '&' : '?'}${query}`);
      if (!page) {
        return false;
      }
      each(page.items.slice(0, maxItems - seen));
      seen += page.items.length;
      token = page.continue;
    } while (token && seen < maxItems);
    return true;
  }

  async get<T>(path: string): Promise<T> {
    const res = await this.request(path);
    await this.assertOk(res, path);
    return (await res.json()) as T;
  }

  async text(path: string): Promise<string> {
    const res = await this.request(path);
    await this.assertOk(res, path);
    return res.text();
  }

  async mergePatch(path: string, body: unknown): Promise<void> {
    const res = await this.request(path, {
      method: 'PATCH',
      headers: { 'content-type': 'application/merge-patch+json' },
      body: JSON.stringify(body),
    });
    await this.assertOk(res, path);
  }

  async create(path: string, body: unknown): Promise<void> {
    const res = await this.request(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    await this.assertOk(res, path);
  }

  private request(path: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    const token = this.token();
    if (token) {
      headers.set('authorization', `Bearer ${token}`);
    }
    headers.set('accept', 'application/json');
    return fetch(`${this.baseUrl}${path}`, { ...init, headers, signal: AbortSignal.timeout(15_000) });
  }

  private token(): string | undefined {
    if (process.env.K8S_API_URL) {
      return process.env.K8S_TOKEN;
    }
    try {
      return readFileSync(`${SA_DIR}/token`, 'utf8').trim();
    } catch {
      return undefined;
    }
  }

  private async assertOk(res: Response, path: string): Promise<void> {
    if (res.ok) {
      return;
    }
    let detail = res.statusText;
    try {
      const body = (await res.json()) as { message?: string };
      detail = body.message ?? detail;
    } catch {
      // not JSON
    }
    throw new KubeError(res.status, `${res.status} on ${path}: ${detail}`);
  }
}
