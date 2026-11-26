import { KubeError } from '../kube/kube-client';
import type { WatchApi } from '../kube/watch-cache';

interface Stream {
  path: string;
  push(event: { type: string; object: unknown }): void;
  /** The server ends the watch (timeoutSeconds reached). */
  end(): void;
  /** The connection breaks. */
  fail(err?: Error): void;
  aborted: boolean;
}

/**
 * A pretend API server for watch caches: lists answer from `objects` (paged
 * by `limit`), watches hand the test a stream to push events into. Every
 * request is recorded, so tests can see resourceVersions and relists.
 */
export class FakeWatchApi implements WatchApi {
  objects: unknown[] = [];
  resourceVersion = '100';
  /** Set to make lists fail with this status (404: not installed). */
  listStatus: number | null = null;
  /** Set to make watch requests answer with this status (410, 403, 500). */
  watchStatus: number | null = null;
  readonly requests: string[] = [];
  readonly streams: Stream[] = [];
  private waiters: ((s: Stream) => void)[] = [];

  async get<T>(path: string): Promise<T> {
    this.requests.push(`GET ${path}`);
    if (this.listStatus !== null) {
      throw new KubeError(this.listStatus, `${this.listStatus} on ${path}`);
    }
    const url = new URL(path, 'http://x');
    const limit = Number(url.searchParams.get('limit') ?? 1e9);
    const start = Number(url.searchParams.get('continue') ?? 0);
    const items = this.objects.slice(start, start + limit);
    const next = start + limit < this.objects.length ? String(start + limit) : undefined;
    return { metadata: { resourceVersion: this.resourceVersion, ...(next ? { continue: next } : {}) }, items } as T;
  }

  async watch(path: string, signal: AbortSignal): Promise<Response> {
    this.requests.push(`WATCH ${path}`);
    if (this.watchStatus !== null) {
      return new Response(JSON.stringify({ code: this.watchStatus }), { status: this.watchStatus });
    }
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({ start: (c) => (controller = c) });
    const encoder = new TextEncoder();
    const stream: Stream = {
      path,
      aborted: false,
      push: (event) => controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`)),
      end: () => controller.close(),
      fail: (err = new Error('connection reset')) => controller.error(err),
    };
    signal.addEventListener('abort', () => {
      stream.aborted = true;
      try {
        controller.error(new Error('aborted'));
      } catch {
        // already closed
      }
    });
    this.streams.push(stream);
    this.waiters.splice(0).forEach((w) => w(stream));
    return new Response(body, { status: 200 });
  }

  /** The next watch stream (or the current one when `count` streams exist already). */
  async stream(count = this.streams.length + 1): Promise<Stream> {
    while (this.streams.length < count) {
      await new Promise<Stream>((resolve) => this.waiters.push(resolve));
    }
    return this.streams[count - 1];
  }
}

export function pod(name: string, rv: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    metadata: {
      name,
      namespace: 'default',
      resourceVersion: rv,
      managedFields: [{ manager: 'kubectl', fieldsV1: { 'f:spec': {} } }],
      annotations: {
        'kubectl.kubernetes.io/last-applied-configuration': '{"huge":true}',
        'weave.works/kured-node-lock': 'x',
      },
      labels: { app: name },
    },
    spec: {
      nodeName: 'n1',
      containers: [
        {
          name: 'c',
          image: 'nginx:1',
          env: [{ name: 'SECRET_LOOKING', value: 'x'.repeat(1000) }],
          resources: { limits: { memory: '1Gi' } },
          livenessProbe: { httpGet: { path: '/' } },
        },
      ],
    },
    status: {
      phase: 'Running',
      conditions: [{ type: 'Ready', status: 'True' }],
      containerStatuses: [{ name: 'c', ready: true, restartCount: 0, state: { running: {} } }],
    },
    ...extra,
  };
}

export const until = async (fn: () => boolean, ms = 2000): Promise<void> => {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) {
      throw new Error('timed out waiting');
    }
    await new Promise((r) => setTimeout(r, 2));
  }
};
