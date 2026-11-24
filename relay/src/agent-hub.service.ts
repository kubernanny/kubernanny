import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { Inject, Injectable, Logger, BeforeApplicationShutdown, OnApplicationBootstrap } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import { FrameType, HEARTBEAT_PING, HEARTBEAT_PONG, REPLY_CHUNK, RegistrationChallenge, RelayClose, RelayFrameError, decodeFrame, encodeFrame } from '@kubernanny/protocol';
import { RawData, WebSocket, WebSocketServer } from 'ws';
import { AgentLink, CallResult } from './core/agent-link';
import { idPrefix, parseRoute, pathOf } from './core/http';
import { ByteBudget, clientAddress, shareBytes } from './core/limits';
import { checkRegistration } from './core/registration';
import { RELAY_CONFIG, RelayConfig } from './config';
import { RelayMetrics } from './metrics';

interface Connection {
  socket: WebSocket;
  agentId: string;
  lastSeen: number;
  link: AgentLink | null;
  /** The client address the pending limit counts this connection under. */
  address: string;
  pending: boolean;
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
 * thousand agents idle here.
 */
@Injectable()
export class AgentHub implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private readonly logger = new Logger('relay');
  private readonly agents = new Map<string, Connection>();
  /** Unproven connections, oldest first (a Set keeps insertion order). */
  private readonly pendingConnections = new Set<Connection>();
  private readonly pendingByAddress = new Map<string, number>();
  private readonly budget: ByteBudget;
  /** Registered agents per client address, and the share of the answer budget they hold together. */
  private readonly byAddress = new Map<string, { agents: Set<Connection>; budget: ByteBudget }>();
  private readonly wss = new WebSocketServer({ noServer: true, maxPayload: MAX_AGENT_MESSAGE, perMessageDeflate: false, clientTracking: false });
  private sweeper: ReturnType<typeof setInterval> | null = null;

  constructor(
    @Inject(HttpAdapterHost) private readonly adapterHost: HttpAdapterHost,
    @Inject(RELAY_CONFIG) private readonly config: RelayConfig,
    @Inject(RelayMetrics) private readonly metrics: RelayMetrics,
  ) {
    this.budget = new ByteBudget(config.limits.maxInflightBytes);
  }

  onApplicationBootstrap(): void {
    const server = this.adapterHost.httpAdapter.getHttpServer() as Server;
    server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => this.upgrade(req, socket, head));
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
    const closed = all.map((c) => new Promise<void>((resolve) => (c.socket.readyState === WebSocket.CLOSED ? resolve() : c.socket.once('close', () => resolve()))));
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
    this.pendingByAddress.clear();
    this.byAddress.clear();
  }

  /** Forwards one sealed call to the agent, or says why not. */
  call(agentId: string, body: Uint8Array): Promise<CallResult> {
    const link = this.agents.get(agentId)?.link;
    return link ? link.call(body) : Promise.resolve({ kind: 'error', code: 'RELAY_AGENT_OFFLINE' });
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
    const limits = this.config.limits;
    const address = clientAddress(req.headers, req.socket.remoteAddress, limits.trustProxy);
    const own = this.byAddress.get(address)?.agents.size ?? 0;
    const full = this.agents.size >= limits.maxAgents && this.largestAddress()[1] <= own + 1;
    if (full || own >= limits.maxAgentsPerIp || (this.pendingByAddress.get(address) ?? 0) >= limits.maxPendingPerIp) {
      this.metrics.registration('full');
      const body = JSON.stringify({ code: 'RELAY_FULL' });
      socket.end(`HTTP/1.1 503 Service Unavailable\r\nconnection: close\r\ncontent-type: application/json\r\ncontent-length: ${body.length}\r\n\r\n${body}`);
      return;
    }
    // Full of unproven connections: the oldest goes. A real agent proves its key within one round trip,
    // so holding the pool takes a flood faster than that, not merely a lot of idle sockets.
    while (this.pendingConnections.size >= limits.maxPendingRegistrations) {
      const oldest = this.pendingConnections.values().next().value!;
      this.metrics.registration('timeout');
      this.dropPending(oldest);
      oldest.socket.terminate();
    }
    this.wss.handleUpgrade(req, socket, head, (ws) => this.accept(ws, route.agentId, address));
  }

  private dropPending(connection: Connection): void {
    if (!connection.pending) {
      return;
    }
    connection.pending = false;
    this.pendingConnections.delete(connection);
    const left = (this.pendingByAddress.get(connection.address) ?? 1) - 1;
    if (left > 0) {
      this.pendingByAddress.set(connection.address, left);
    } else {
      this.pendingByAddress.delete(connection.address);
    }
    this.metrics.pending = this.pendingConnections.size;
  }

  private accept(socket: WebSocket, agentId: string, address: string): void {
    const connection: Connection = { socket, agentId, lastSeen: Date.now(), link: null, address, pending: true };
    const challenge = new RegistrationChallenge();
    this.pendingConnections.add(connection);
    this.pendingByAddress.set(address, (this.pendingByAddress.get(address) ?? 0) + 1);
    this.metrics.pending = this.pendingConnections.size;
    const timer = setTimeout(() => {
      this.metrics.registration('timeout');
      // Out of the pool at once; a peer that does not read could hold a polite close for 30 s.
      this.dropPending(connection);
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
        if (!connection.pending) {
          return; // timed out or evicted: no late registration
        }
        clearTimeout(timer);
        const outcome = checkRegistration(challenge, bytes, agentId);
        if (!outcome.ok) {
          this.metrics.registration(outcome.close === RelayClose.ProofFailed ? 'proof_failed' : 'protocol');
          this.dropPending(connection);
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
      this.dropPending(connection);
      connection.link?.shutdown();
      this.leaveAddress(connection);
      if (this.agents.get(agentId) === connection) {
        this.agents.delete(agentId);
        this.logger.log(`agent ${idPrefix(agentId)} disconnected`);
      }
      this.metrics.pending = this.pendingConnections.size;
      this.metrics.agents = this.agents.size;
    });
    socket.on('error', () => socket.terminate());
    socket.send(challenge.frame());
  }

  private register(connection: Connection): void {
    const { socket, agentId, address } = connection;
    const limits = this.config.limits;
    this.dropPending(connection);
    const previous = this.agents.get(agentId);
    if (!previous) {
      // Checked again here: several connections of one address may have passed the upgrade check at once.
      const own = this.byAddress.get(address)?.agents.size ?? 0;
      if (own >= limits.maxAgentsPerIp) {
        this.metrics.registration('full');
        socket.close(RelayClose.Full, 'too many agents from this address');
        return;
      }
      if (this.agents.size >= limits.maxAgents) {
        // Full: the address holding the most gives one up, unless the newcomer's would then hold as many.
        const [largest, count] = this.largestAddress();
        const victim = largest === null || count <= own + 1 ? null : this.byAddress.get(largest)!.agents.values().next().value!;
        if (!victim) {
          this.metrics.registration('full');
          socket.close(RelayClose.Full, 'relay full');
          return;
        }
        this.evict(victim);
      }
    }
    const entry = this.addressEntry(address);
    connection.link = new AgentLink({ send: (bytes) => socket.send(bytes), close: (code, reason) => socket.close(code, reason) }, limits, { parent: entry.budget });
    entry.agents.add(connection);
    this.agents.set(agentId, connection);
    if (previous) {
      // Newest wins: after a restart the old socket may linger half-open until the idle timeout.
      this.leaveAddress(previous);
      previous.link?.shutdown();
      previous.socket.close(RelayClose.Replaced, 'replaced');
    }
    socket.send(encodeFrame(FrameType.Ready, 0, new TextEncoder().encode(JSON.stringify(connection.link.info()))));
    this.metrics.registration('ok');
    this.metrics.pending = this.pendingConnections.size;
    this.metrics.agents = this.agents.size;
    this.logger.log(`agent ${idPrefix(agentId)} registered${previous ? ', replacing its previous connection' : ''}`);
  }

  private addressEntry(address: string): { agents: Set<Connection>; budget: ByteBudget } {
    let entry = this.byAddress.get(address);
    if (!entry) {
      entry = { agents: new Set(), budget: new ByteBudget(shareBytes(this.config.limits), this.budget) };
      this.byAddress.set(address, entry);
    }
    return entry;
  }

  private leaveAddress(connection: Connection): void {
    const entry = this.byAddress.get(connection.address);
    if (entry?.agents.delete(connection) && entry.agents.size === 0) {
      this.byAddress.delete(connection.address);
    }
  }

  /** The address with the most registered agents, and how many. */
  private largestAddress(): [string | null, number] {
    let best: [string | null, number] = [null, 0];
    for (const [address, entry] of this.byAddress) {
      if (entry.agents.size > best[1]) {
        best = [address, entry.agents.size];
      }
    }
    return best;
  }

  private evict(connection: Connection): void {
    this.leaveAddress(connection);
    if (this.agents.get(connection.agentId) === connection) {
      this.agents.delete(connection.agentId);
    }
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
  }
}

function toBytes(data: RawData): Uint8Array {
  if (Array.isArray(data)) {
    return new Uint8Array(Buffer.concat(data));
  }
  return data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
}
