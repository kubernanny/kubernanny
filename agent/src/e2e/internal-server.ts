import { chmodSync, existsSync, unlinkSync } from 'node:fs';
import { IncomingMessage, Server, ServerResponse, createServer, request } from 'node:http';
import { Inject, Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import type { Language } from '@kubernanny/protocol';
import { INTERNAL, LANGUAGE_HEADER, PRINCIPAL_HEADER } from '../auth/principal.guard';
import { CONFIG, Config } from '../config';

/** Largest response the internal routes may produce; the views stay far below. */
export const MAX_INTERNAL_RESPONSE = 8 * 1024 * 1024;
const TIMEOUT_MS = 30_000;

export interface InternalResponse {
  status: number;
  body: Buffer;
}

/**
 * The API's own routes, reachable only through a Unix socket inside the pod
 * (`INTERNAL_SOCKET`, default /tmp/kubernanny.sock, mode 0600).
 *
 * The end-to-end channel decrypts a request and hands it in here, naming the
 * device the handshake proved; the routes, pipes and guards are the same as
 * ever. The admin CLI (`kubectl exec … node dist/cli.js`) talks to the same
 * socket. Nothing on the network reaches it: the Service only knows the TCP
 * port, and outgoing HTTP calls of the agent (Prometheus, Grafana, webhooks)
 * cannot be steered onto a socket file.
 */
@Injectable()
export class InternalServer implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(InternalServer.name);
  private server: Server | null = null;

  constructor(
    @Inject(HttpAdapterHost) private readonly adapterHost: HttpAdapterHost,
    @Inject(CONFIG) private readonly config: Config,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    const handler = this.adapterHost.httpAdapter.getInstance() as (req: IncomingMessage, res: ServerResponse) => void;
    const path = this.config.internalSocket;
    // sun_path holds 108 bytes on Linux (104 on macOS); longer paths are cut and collide.
    if (Buffer.byteLength(path) > 100) {
      throw new Error(`INTERNAL_SOCKET is longer than 100 bytes, which Unix sockets do not allow: ${path}`);
    }
    if (existsSync(path)) {
      unlinkSync(path); // left over from a crash; listen() fails otherwise
    }
    this.server = createServer((req, res) => {
      (req as IncomingMessage & { [INTERNAL]?: true })[INTERNAL] = true;
      handler(req, res);
    });
    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject).listen(path, () => resolve());
    });
    chmodSync(path, 0o600);
    this.logger.log(`internal API on ${path}`);
  }

  async onModuleDestroy(): Promise<void> {
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
  }

  /** One API call as `principal` ("admin", "demo" or a device id), answered in `language`. `path` is below /api and already validated. */
  dispatch(principal: string, method: string, path: string, body?: unknown, language?: Language): Promise<InternalResponse> {
    return call(this.config.internalSocket, principal, method, path, body, language);
  }
}

/** Also used by the CLI, which runs in a separate process in the same pod. */
export function call(socketPath: string, principal: string, method: string, path: string, body?: unknown, language?: Language): Promise<InternalResponse> {
  const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
  return new Promise((resolve, reject) => {
    const req = request(
      {
        socketPath,
        method,
        path: `/api${path}`,
        timeout: TIMEOUT_MS,
        headers: {
          [PRINCIPAL_HEADER]: principal,
          ...(language ? { [LANGUAGE_HEADER]: language } : {}),
          ...(payload ? { 'content-type': 'application/json', 'content-length': payload.length } : {}),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > MAX_INTERNAL_RESPONSE) {
            req.destroy(new Error('internal response too large'));
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () => resolve({ status: res.statusCode ?? 500, body: Buffer.concat(chunks) }));
        res.on('error', reject);
      },
    );
    req.on('timeout', () => req.destroy(new Error('internal request timed out')));
    req.on('error', reject);
    req.end(payload);
  });
}
