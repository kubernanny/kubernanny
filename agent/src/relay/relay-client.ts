import { Inject, Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import {
  FrameType,
  HEARTBEAT_PING,
  MAX_SEALED_REQUEST,
  RelayClose,
  RelayFrameError,
  answerChallenge,
  decodeFrame,
  encodeReply,
  relayAgentId,
} from '@kubernanny/protocol';
import { RawData, WebSocket } from 'ws';
import { IdentityService } from '../auth/identity.service';
import { CONFIG, Config } from '../config';
import { E2eService } from '../e2e/e2e.service';
import { relayHttpUrl, relaySocketUrl } from './relay-url';

export const RECONNECT_MIN_MS = 1_000;
export const RECONNECT_MAX_MS = 60_000;
/** After "replaced" another instance holds the id (two replicas, or a stale one): back off, so they do not take turns every second. */
const REPLACED_MIN_MS = 30_000;
const PING_EVERY_MS = 25_000;
/** No message at all (a pong at least) for this long: the connection is dead even if TCP has not noticed. */
const DEAD_AFTER_MS = 60_000;
/** The largest message the relay may send: a Call frame around the largest sealed request (the same cap as POST /api/e2e). Anything bigger is refused before it is buffered. */
export const MAX_RELAY_MESSAGE = MAX_SEALED_REQUEST + 64;
/**
 * Calls handled at once. The relay forwards at most its own per-agent
 * concurrency (8 by default); more come only from a relay that misbehaves,
 * and are refused like a rate-limited direct call, without any work.
 */
export const MAX_IN_FLIGHT = 16;
/** Answers queued for a relay that does not read them: past this the connection is dropped instead of filling memory. */
const MAX_BUFFERED_BYTES = 16 * 1024 * 1024;
/** A connection must have lasted this long before the backoff starts over: a relay that accepts and drops at once cannot make the agent reconnect every second. */
const STABLE_AFTER_MS = 30_000;

/**
 * How long to wait before reconnecting: exponential from 1 s to 60 s with
 * "equal jitter" (half fixed, half random), so a relay restart does not get
 * every agent back in the same second.
 */
export function reconnectDelay(attempt: number, closeCode: number | undefined, random: number): number {
  const ceiling = Math.min(RECONNECT_MAX_MS, RECONNECT_MIN_MS * 2 ** Math.min(attempt, 16));
  const delay = ceiling / 2 + (ceiling / 2) * random;
  if (closeCode === RelayClose.ProofFailed) {
    return RECONNECT_MAX_MS; // the relay does not take our proof; hammering it will not change that
  }
  if (closeCode === RelayClose.Replaced) {
    return Math.max(REPLACED_MIN_MS, delay);
  }
  return delay;
}

export interface RelayStatus {
  /** The relay's address for the app (https), as in the pairing link. */
  url: string;
  connected: boolean;
}

/** Per connection: what the relay has done so far, so each step happens once. */
interface Session {
  socket: WebSocket;
  answered: boolean;
  readyAt: number;
  /** Calls the agent is working on: only these can be cancelled, and their ids are not taken twice. */
  inFlight: Set<number>;
  cancelled: Set<number>;
}

/**
 * The agent's one outbound connection to the relay, when RELAY_URL is set
 * (docs/RELAY.md). It registers under the hash of the agent's public key,
 * proves it holds the private key, and hands every call the relay forwards
 * to the same E2eService as POST /api/e2e: rate limit, replay cache,
 * authentication and dispatch stay in one place, and the relay never gets
 * more than the sealed bytes.
 *
 * The relay is not trusted with the agent's resources either: a message is
 * at most one request in size, the challenge is answered once per
 * connection, cancels count only for calls in flight, calls in flight are
 * capped, unread answers do not pile up, and a relay that drops the
 * connection right away does not reset the backoff. A hostile relay gets no
 * more out of the agent than a direct caller could.
 */
@Injectable()
export class RelayClient implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger('relay');
  private session: Session | null = null;
  private connected = false;
  private attempt = 0;
  private lastHeard = 0;
  private stopped = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeat: ReturnType<typeof setInterval> | null = null;

  constructor(
    @Inject(CONFIG) private readonly config: Config,
    @Inject(IdentityService) private readonly identity: IdentityService,
    @Inject(E2eService) private readonly e2e: E2eService,
  ) {}

  status(): RelayStatus | null {
    return this.config.relayUrl ? { url: relayHttpUrl(this.config.relayUrl), connected: this.connected } : null;
  }

  /** For tests and diagnostics: what the current connection holds. */
  stats(): { inFlight: number; cancelled: number } {
    return { inFlight: this.session?.inFlight.size ?? 0, cancelled: this.session?.cancelled.size ?? 0 };
  }

  onApplicationBootstrap(): void {
    if (this.config.relayUrl) {
      this.connect();
    }
  }

  onModuleDestroy(): void {
    this.stopped = true;
    this.clearTimers();
    this.session?.socket.terminate();
    this.session = null;
  }

  private connect(): void {
    if (this.stopped) {
      return;
    }
    const agentId = relayAgentId(this.identity.keyPair.publicKey);
    const socket = new WebSocket(relaySocketUrl(this.config.relayUrl!, agentId), { maxPayload: MAX_RELAY_MESSAGE, perMessageDeflate: false, handshakeTimeout: 10_000 });
    const session: Session = { socket, answered: false, readyAt: 0, inFlight: new Set(), cancelled: new Set() };
    this.session = session;
    this.lastHeard = Date.now();
    // Every handler checks that it still belongs to the current session (isCurrent): a dead one may report late.
    socket.on('message', (data: RawData, isBinary: boolean) => {
      if (this.isCurrent(session)) {
        this.lastHeard = Date.now();
        if (isBinary) {
          this.onFrame(session, toBytes(data));
        }
      }
    });
    socket.on('close', (code: number, reason: Buffer) => {
      this.lost(session, code, reason.toString().slice(0, 100));
    });
    socket.on('error', () => undefined); // followed by close; ws closes with 1009 on an oversized message
    this.heartbeat = setInterval(() => this.beat(session), PING_EVERY_MS);
    this.heartbeat.unref();
  }

  private onFrame(session: Session, bytes: Uint8Array): void {
    const { socket } = session;
    let frame;
    try {
      frame = decodeFrame(bytes);
    } catch (err) {
      if (err instanceof RelayFrameError) {
        socket.close(RelayClose.Protocol, 'bad frame');
        return;
      }
      throw err;
    }
    switch (frame.type) {
      case FrameType.Challenge:
        // One X25519 per connection: a second challenge is a relay trying to make the agent compute.
        if (session.answered) {
          socket.close(RelayClose.Protocol, 'second challenge');
          return;
        }
        session.answered = true;
        try {
          socket.send(answerChallenge(this.identity.keyPair, frame.payload));
        } catch {
          socket.close(RelayClose.Protocol, 'bad challenge');
        }
        return;
      case FrameType.Ready:
        if (session.answered && !session.readyAt) {
          session.readyAt = Date.now();
          this.connected = true;
          this.logger.log(`connected to the relay ${relayHttpUrl(this.config.relayUrl!)}`);
        }
        return;
      case FrameType.Call:
        if (session.readyAt) {
          this.call(session, frame.callId, frame.payload);
        }
        return;
      case FrameType.Cancel:
        // Only a call in flight can be cancelled; any other id is ignored, so the set is bounded by MAX_IN_FLIGHT.
        if (session.inFlight.has(frame.callId)) {
          session.cancelled.add(frame.callId);
        }
        return;
      default:
        return; // unknown types are ignored, so the relay can add some later
    }
  }

  private call(session: Session, callId: number, payload: Uint8Array): void {
    if (session.inFlight.has(callId)) {
      return; // an id still in use: the relay is confused or hostile, and one answer per id is all it gets
    }
    if (session.inFlight.size >= MAX_IN_FLIGHT) {
      this.send(session, callId, 429, json({ code: 'E2E_RATE_LIMITED' }));
      return;
    }
    session.inFlight.add(callId);
    void this.answer(session, callId, payload.slice());
  }

  private async answer(session: Session, callId: number, body: Uint8Array): Promise<void> {
    let status: number;
    let payload: Uint8Array;
    if (body.length > MAX_SEALED_REQUEST) {
      [status, payload] = [413, json({ code: 'E2E_TOO_LARGE' })];
    } else {
      try {
        const result = await this.e2e.handle(body, Date.now(), 'relay');
        [status, payload] = result.kind === 'sealed' ? [200, result.body] : [result.status, json({ code: result.code })];
      } catch {
        [status, payload] = [503, json({ code: 'E2E_BUSY' })];
      }
    }
    session.inFlight.delete(callId);
    if (session.cancelled.delete(callId)) {
      return;
    }
    this.send(session, callId, status, payload);
  }

  private send(session: Session, callId: number, status: number, payload: Uint8Array): void {
    const { socket } = session;
    if (!this.isCurrent(session) || socket.readyState !== WebSocket.OPEN) {
      return;
    }
    if (socket.bufferedAmount + payload.length > MAX_BUFFERED_BYTES) {
      // The relay does not read what it asked for; dropping the connection frees what is queued.
      socket.terminate();
      return;
    }
    for (const frame of encodeReply(callId, status, payload)) {
      socket.send(frame);
    }
  }

  private beat(session: Session): void {
    if (!this.isCurrent(session)) {
      return;
    }
    if (Date.now() - this.lastHeard > DEAD_AFTER_MS) {
      // Waiting for a close handshake on a dead connection could take minutes: drop it and move on.
      // lost() first, so its late 'close' event finds the session no longer current.
      this.lost(session, undefined, 'no heartbeat');
      session.socket.terminate();
      return;
    }
    if (session.socket.readyState === WebSocket.OPEN) {
      session.socket.send(HEARTBEAT_PING);
    }
  }

  /** The one place that decides whether an event still belongs to the live connection. */
  private isCurrent(session: Session): boolean {
    return this.session === session;
  }

  /** `session` ended; ignored when it is not the current one (a dead connection reporting late). */
  private lost(session: Session, code: number | undefined, reason: string): void {
    if (!this.isCurrent(session)) {
      return;
    }
    const wasConnected = this.connected;
    this.connected = false;
    this.session = null;
    this.clearTimers();
    if (this.stopped) {
      return;
    }
    // The backoff starts over only after a connection that held for a while.
    if (session.readyAt && Date.now() - session.readyAt >= STABLE_AFTER_MS) {
      this.attempt = 0;
    }
    const delay = reconnectDelay(this.attempt++, code, Math.random());
    const why = `${code ?? ''} ${reason}`.trim();
    if (wasConnected || this.attempt === 1) {
      this.logger.warn(`relay connection lost${why ? ` (${why})` : ''}, reconnecting in ${Math.round(delay / 1000)} s`);
    }
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
    this.reconnectTimer.unref();
  }

  private clearTimers(): void {
    if (this.heartbeat) {
      clearInterval(this.heartbeat);
      this.heartbeat = null;
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }
}

function toBytes(data: RawData): Uint8Array {
  if (Array.isArray(data)) {
    return new Uint8Array(Buffer.concat(data));
  }
  return data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
}

const json = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
