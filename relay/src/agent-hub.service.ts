import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';

import {
  decodeFrame,
  encodeFrame,
  FrameType,
  HEARTBEAT_PING,
  HEARTBEAT_PONG,
  RelayClose,
  RelayFrameError,
  REPLY_CHUNK,
} from '@kubernanny/protocol';
import { BeforeApplicationShutdown, Inject, Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import { RawData, WebSocket, WebSocketServer } from 'ws';

import { RELAY_CONFIG, RelayConfig } from './config';
import { Admission } from './core/admission';
import { AgentLink, CallResult } from './core/agent-link';
import { idPrefix, parseRoute, pathOf, registrationOrigin, toBytes } from './core/http';
import { clientAddress } from './core/limits';
import { FcmClient, GoogleErrorLog, PushSender, pushSender } from './core/push';
import { endSession, openSession, proveSession, Session } from './core/session';
import { DeadmanRegistry } from './deadman-registry';
import { RelayMetrics } from './metrics';

interface Connection {
  socket: WebSocket;
  agentId: string;
  lastSeen: number;
  link: AgentLink | null;
  /** The client address the per-address limits count this connection under. */
  address: string;
  session: Session;
}

/** The largest message an agent sends: one reply chunk plus the frame header and status. */
const MAX_AGENT_MESSAGE = REPLY_CHUNK + 64;

/**
 * The agents' side of the relay: one WebSocket per agent, on
 * `GET /v1/agents/{agentId}/ws` of the same port as the HTTP API.
 *
 * Plain `ws` on the HTTP server's upgrade event rather than a Nest gateway:
 * a gateway brings an adapter and a message router for a protocol that has
 * four frame types, and every byte of per-connection state counts when ten
 * thousand agents idle here. The per-address and relay-wide rules live in
 * `Admission`, the registration states in `core/session.ts` (shared with the
 * Worker).
 */
@Injectable()
export class AgentHub implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private readonly logger = new Logger('relay');
  private readonly agents = new Map<string, Connection>();
  /** Unproven connections, oldest first (a Set keeps insertion order). */
  private readonly pendingConnections = new Set<Connection>();
  private readonly admission: Admission<Connection>;
  private readonly wss = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_AGENT_MESSAGE,
    perMessageDeflate: false,
    clientTracking: false,
  });
  private sweeper: ReturnType<typeof setInterval> | null = null;
  /** One sender for every agent, so the per-token limit spans them all; null without push. */
  private readonly send: PushSender | null;
  private warnedNoOrigin = false;
  /** The dead man's switch per agent id, in memory (deadman-registry.ts). */
  private readonly deadmen: DeadmanRegistry;

  constructor(
    @Inject(HttpAdapterHost) private readonly adapterHost: HttpAdapterHost,
    @Inject(RELAY_CONFIG) private readonly config: RelayConfig,
    @Inject(RelayMetrics) private readonly metrics: RelayMetrics,
  ) {
    // Google's refusals in the relay's own log format (docs/RELAY.md, "Logs").
    const fcm = config.push.account
      ? new FcmClient(config.push.account, undefined, undefined, new GoogleErrorLog((line) => this.logger.warn(line)))
      : null;
    const send = pushSender(config.push, fcm);
    this.admission = new Admission(config.limits, send ? config.push : null, Date.now());
    this.send = send
      ? async (request) => {
          const outcome = await send(request);
          this.metrics.push(outcome);
          return outcome;
        }
      : null;
    this.deadmen = new DeadmanRegistry(
      config.deadman,
      this.send,
      this.admission,
      metrics,
      (line) => this.logger.log(line),
      (agentId) => this.agents.has(agentId),
    );
  }

  onApplicationBootstrap(): void {
    const server = this.adapterHost.httpAdapter.getHttpServer() as Server;
    server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => this.upgrade(req, socket, head));
    this.logger.log(
      this.send ? `native push on (FCM project ${this.config.push.account!.projectId})` : 'native push off',
    );
    if (this.send) {
      this.logger.log(
        this.config.deadman.enabled
          ? "dead man's switch on (deposits are held in memory: a restart of the relay forgets them)"
          : "dead man's switch off",
      );
    }
    this.logger.log(
      this.config.publicOrigin
        ? `agents register for ${this.config.publicOrigin}`
        : 'RELAY_PUBLIC_URL unset: only agents dialling a loopback address can register',
    );
    const every = Math.max(1000, Math.min(30_000, this.config.limits.idleTimeoutMs / 3));
    this.sweeper = setInterval(() => this.sweep(Date.now()), every);
    this.sweeper.unref();
  }

  async beforeApplicationShutdown(): Promise<void> {
    if (this.sweeper) {
      clearInterval(this.sweeper);
    }
    // 1001 "going away": agents reconnect with backoff, to this relay's successor.
    const all = [...this.agents.values(), ...this.pendingConnections];
    const closed = all.map(
      (c) =>
        new Promise<void>((resolve) =>
          c.socket.readyState === WebSocket.CLOSED ? resolve() : c.socket.once('close', () => resolve()),
        ),
    );
    for (const connection of all) {
      connection.link?.shutdown();
      connection.socket.close(1001, 'relay restarting');
    }
    await Promise.race([Promise.all(closed), new Promise((resolve) => setTimeout(resolve, 1000))]);
    for (const connection of all) {
      connection.socket.terminate();
    }
    this.agents.clear();
    this.pendingConnections.clear();
    this.admission.clear();
    this.deadmen.clear();
  }

  /** Forwards one sealed call from `caller` (the client address) to the agent, or says why not. */
  call(agentId: string, body: Uint8Array, caller?: string): Promise<CallResult> {
    const link = this.agents.get(agentId)?.link;
    return link ? link.call(body, caller) : Promise.resolve({ kind: 'error', code: 'RELAY_AGENT_OFFLINE' });
  }

  /**
   * Never throws: a request target or header that trips anything here must
   * cost that one socket, not the process (security review C1: one
   * `GET http://[` used to kill the relay).
   */
  private upgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    socket.on('error', () => socket.destroy());
    try {
      this.tryUpgrade(req, socket, head);
    } catch (err) {
      this.logger.error(`upgrade failed: ${err instanceof Error ? err.message : String(err)}`);
      socket.destroy();
    }
  }

  private tryUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    const path = pathOf(req.url);
    const route = path === null ? null : parseRoute(path);
    if (route?.kind !== 'connect') {
      socket.end('HTTP/1.1 404 Not Found\r\nconnection: close\r\ncontent-length: 0\r\n\r\n');
      return;
    }
    const origin = registrationOrigin(this.config.publicOrigin, req.headers.host);
    if (!origin) {
      if (!this.warnedNoOrigin) {
        this.warnedNoOrigin = true;
        this.logger.warn('refusing agent connections: set RELAY_PUBLIC_URL to the URL agents dial (docs/RELAY.md)');
      }
      socket.end('HTTP/1.1 404 Not Found\r\nconnection: close\r\ncontent-length: 0\r\n\r\n');
      return;
    }
    const limits = this.config.limits;
    const address = clientAddress(req.headers, req.socket.remoteAddress, limits.trustProxy);
    if (this.admission.refuseConnect(address, this.agents.size)) {
      this.metrics.registration('full');
      const body = JSON.stringify({ code: 'RELAY_FULL' });
      socket.end(
        `HTTP/1.1 503 Service Unavailable\r\nconnection: close\r\ncontent-type: application/json\r\ncontent-length: ${body.length}\r\n\r\n${body}`,
      );
      return;
    }
    // Full of unproven connections: the oldest goes. A real agent proves its key within one round trip,
    // so holding the pool takes a flood faster than that, not merely a lot of idle sockets.
    while (this.pendingConnections.size >= limits.maxPendingRegistrations) {
      const oldest = this.pendingConnections.values().next().value!;
      this.metrics.registration('timeout');
      this.endPending(oldest);
      oldest.socket.terminate();
    }
    this.wss.handleUpgrade(req, socket, head, (ws) => this.accept(ws, route.agentId, address, origin));
  }

  /** A pending connection that may not register any more: out of the pool, its challenge forgotten. */
  private endPending(connection: Connection): void {
    if (connection.session.phase !== 'pending') {
      return;
    }
    connection.session = endSession(connection.session);
    this.pendingConnections.delete(connection);
    this.admission.removePending(connection.address);
    this.metrics.pending = this.pendingConnections.size;
  }

  private accept(socket: WebSocket, agentId: string, address: string, origin: string): void {
    const { session, challenge } = openSession(agentId, origin, Date.now());
    const connection: Connection = { socket, agentId, lastSeen: Date.now(), link: null, address, session };
    this.pendingConnections.add(connection);
    this.admission.addPending(address);
    this.metrics.pending = this.pendingConnections.size;
    const timer = setTimeout(() => {
      this.metrics.registration('timeout');
      // Out of the pool at once; a peer that does not read could hold a polite close for 30 s.
      this.endPending(connection);
      socket.close(RelayClose.RegistrationTimeout, 'no proof');
      setTimeout(() => socket.terminate(), 1000).unref();
    }, this.config.limits.registerTimeoutMs);

    socket.on('message', (data: RawData, isBinary: boolean) => {
      connection.lastSeen = Date.now();
      if (!isBinary) {
        if (data.toString() === HEARTBEAT_PING) {
          socket.send(HEARTBEAT_PONG);
        }
        return;
      }
      const bytes = toBytes(data);
      if (!connection.link) {
        if (connection.session.phase !== 'pending') {
          return; // timed out, evicted or failed: no late registration
        }
        clearTimeout(timer);
        this.pendingConnections.delete(connection);
        this.admission.removePending(address);
        const { session: next, outcome } = proveSession(connection.session, bytes, Date.now());
        connection.session = next;
        this.metrics.pending = this.pendingConnections.size;
        if (outcome && !outcome.ok) {
          this.metrics.registration(outcome.close === RelayClose.ProofFailed ? 'proof_failed' : 'protocol');
          socket.close(outcome.close, outcome.reason);
          return;
        }
        this.register(connection);
        return;
      }
      try {
        connection.link.onFrame(decodeFrame(bytes));
      } catch (err) {
        if (!(err instanceof RelayFrameError)) {
          throw err;
        }
        socket.close(RelayClose.Protocol, 'bad frame');
      }
    });
    socket.on('close', () => {
      clearTimeout(timer);
      this.endPending(connection);
      connection.link?.shutdown();
      this.admission.leave(address, connection);
      if (this.agents.get(agentId) === connection) {
        this.agents.delete(agentId);
        this.admission.pushPolicyLeft(agentId, Date.now());
        this.deadmen.lost(agentId, connection.lastSeen);
        this.logger.log(`agent ${idPrefix(agentId)} disconnected`);
      }
      this.metrics.pending = this.pendingConnections.size;
      this.metrics.agents = this.agents.size;
    });
    socket.on('error', () => socket.terminate());
    socket.send(challenge);
  }

  private register(connection: Connection): void {
    const { socket, agentId, address } = connection;
    const limits = this.config.limits;
    const previous = this.agents.get(agentId);
    if (!previous) {
      // Checked again here: several connections of one address may have passed the upgrade check at once.
      const own = this.admission.agentsOf(address);
      if (own >= limits.maxAgentsPerIp) {
        this.metrics.registration('full');
        connection.session = endSession(connection.session);
        socket.close(RelayClose.Full, 'too many agents from this address');
        return;
      }
      if (this.agents.size >= limits.maxAgents) {
        // Full: the address holding the most gives one up, unless the newcomer's would then hold as many.
        const [victim, count] = this.admission.largest();
        if (!victim || count <= own + 1) {
          this.metrics.registration('full');
          connection.session = endSession(connection.session);
          socket.close(RelayClose.Full, 'relay full');
          return;
        }
        this.evict(victim);
      }
    }
    const budget = this.admission.join(address, connection);
    const policy = this.admission.pushPolicy(agentId, Date.now());
    connection.link = new AgentLink(
      {
        // ws calls back once the frame is written out, or with an error when the socket closes first.
        send: (bytes, sent) => socket.send(bytes, sent && (() => sent())),
        close: (code, reason) => socket.close(code, reason),
        bufferedAmount: () => socket.bufferedAmount,
        isOpen: () => socket.readyState === WebSocket.OPEN,
      },
      limits,
      {
        parent: budget,
        push:
          this.send && policy
            ? {
                send: this.send,
                policy,
                gate: this.admission.pushGate(address),
                maxInFlight: this.config.push.maxInFlight,
              }
            : null,
        deadman:
          this.send && this.config.deadman.enabled
            ? {
                deposit: (deposit) =>
                  this.agents.get(agentId) === connection ? this.deadmen.deposit(agentId, deposit) : 'disabled',
              }
            : null,
      },
    );
    this.agents.set(agentId, connection);
    const fired = this.deadmen.back(agentId);
    if (previous) {
      // Newest wins: after a restart the old socket may linger half-open until the idle timeout.
      this.admission.leave(previous.address, previous);
      previous.session = endSession(previous.session);
      previous.link?.shutdown();
      previous.socket.close(RelayClose.Replaced, 'replaced');
    }
    socket.send(
      encodeFrame(
        FrameType.Ready,
        0,
        new TextEncoder().encode(
          JSON.stringify({ ...connection.link.info(), ...(fired ? { deadmanFired: fired } : {}) }),
        ),
      ),
    );
    this.metrics.registration('ok');
    this.metrics.pending = this.pendingConnections.size;
    this.metrics.agents = this.agents.size;
    this.logger.log(`agent ${idPrefix(agentId)} registered${previous ? ', replacing its previous connection' : ''}`);
  }

  private evict(connection: Connection): void {
    this.admission.leave(connection.address, connection);
    if (this.agents.get(connection.agentId) === connection) {
      this.agents.delete(connection.agentId);
      this.admission.pushPolicyLeft(connection.agentId, Date.now());
      this.deadmen.lost(connection.agentId, connection.lastSeen);
    }
    connection.session = endSession(connection.session);
    connection.link?.shutdown();
    connection.socket.close(RelayClose.Full, 'relay full, this address holds the most agents');
    this.logger.log(`agent ${idPrefix(connection.agentId)} evicted: relay full`);
  }

  private sweep(now: number): void {
    for (const connection of this.agents.values()) {
      if (now - connection.lastSeen > this.config.limits.idleTimeoutMs) {
        connection.socket.close(RelayClose.Idle, 'idle');
        // A peer that does not answer the close either is cut off.
        setTimeout(() => connection.socket.terminate(), 5000).unref();
      }
    }
    this.admission.prune(now);
    this.deadmen.sweep(now);
  }
}
