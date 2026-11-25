/**
 * One Durable Object per agent id: it holds the agent's WebSocket and
 * forwards the calls for that id to it. Same frames, same registration
 * proof and same per-agent limits as the Node relay, from the same code
 * (`relay/src/core`, `@kubernanny/protocol`); docs/RELAY.md lists the
 * relay-wide limits a Worker has no equivalent for.
 *
 * The WebSocket Hibernation API keeps an idle agent free of charge in
 * memory terms: the object is evicted between calls, the socket stays
 * connected at Cloudflare's edge, and the heartbeat ("ping" -> "pong") is
 * answered by the runtime without waking the object. What must survive an
 * eviction (the agent id, the registration challenge, whether the socket is
 * registered, the state of its rate limits) lives in the socket's
 * attachment, not in fields.
 */
import { FrameType, RegistrationChallenge, RelayClose, RelayFrameError, decodeFrame, encodeFrame, fromBase64Url, toBase64Url } from '@kubernanny/protocol';
import { AgentLink, LinkRates } from '../../src/core/agent-link';
import { RelayErrorCode, relayError } from '../../src/core/http';
import { RelayLimits, parseLimits } from '../../src/core/limits';
import { PushConfig, PushSender, parsePushConfig, pushSender } from '../../src/core/push';
import { checkRegistration } from '../../src/core/registration';

/** The parts of a Workers WebSocket this object uses. */
export interface HibernatableSocket {
  send(message: ArrayBuffer | Uint8Array | string): void;
  close(code?: number, reason?: string): void;
  serializeAttachment(value: unknown): void;
  deserializeAttachment(): unknown;
}

/** The parts of DurableObjectState this object uses. */
export interface AgentObjectState {
  acceptWebSocket(socket: HibernatableSocket): void;
  getWebSockets(): HibernatableSocket[];
  setWebSocketAutoResponse(pair: unknown): void;
  getWebSocketAutoResponseTimestamp(socket: HibernatableSocket): Date | null;
  storage: { setAlarm(time: number): Promise<void>; getAlarm(): Promise<number | null> };
}

/**
 * Unproven sockets one object holds at once. Everything aimed at one agent
 * id lands in one object, so this is the per-id pool; when full the oldest
 * goes, and a real agent, which proves its key in one round trip, still
 * gets in during a flood.
 */
export const MAX_PENDING_PER_OBJECT = 4;

interface Attachment {
  agentId: string;
  /** Registration challenge, base64url, until the proof arrived. */
  nonce?: string;
  secret?: string;
  registered: boolean;
  since: number;
  /**
   * The link's token buckets after its last call. A woken object builds a
   * new link, which would otherwise start with full buckets and never reach
   * the hourly byte cap. Written to the attachment, not to storage: it costs
   * no billed write and lives exactly as long as the socket, as the link
   * does on the Node relay.
   */
  rates?: LinkRates;
}

/** Created per request by the Worker runtime; tests pass their own. */
export interface Runtime {
  newSocketPair(): [client: unknown, server: HibernatableSocket];
  autoResponse(request: string, response: string): unknown;
  upgradeResponse(client: unknown): Response;
}

export class AgentObjectCore {
  private readonly limits: RelayLimits;
  /** Links live only while the object is awake; a call in flight keeps it awake. */
  private readonly links = new Map<HibernatableSocket, AgentLink>();
  /**
   * Native push (secret FCM_SERVICE_ACCOUNT, RELAY_PUSH): null when off. The
   * per-token limit lives in this object, so it is per agent here, not
   * relay-wide as on the Node relay (docs/RELAY.md).
   */
  private readonly push: { config: PushConfig; send: PushSender } | null;

  constructor(
    private readonly state: AgentObjectState,
    env: Record<string, unknown>,
    private readonly runtime: Runtime,
    /** Tests pass a fake FCM; the Worker sends to the real one. */
    send?: PushSender,
  ) {
    this.limits = parseLimits(stringVars(env));
    const config = parsePushConfig(stringVars(env));
    const sender = config.enabled ? (send ?? pushSender(config)) : null;
    this.push = sender ? { config, send: sender } : null;
    state.setWebSocketAutoResponse(runtime.autoResponse('ping', 'pong'));
  }

  /** `connect` from the agent (an upgrade) or `call` from the app; the Worker already checked the route. */
  async fetch(request: Request, kind: 'connect' | 'call', agentId: string): Promise<Response> {
    return kind === 'connect' ? this.connect(agentId) : this.call(request);
  }

  private async connect(agentId: string): Promise<Response> {
    this.makeRoomForPending();
    const [client, server] = this.runtime.newSocketPair();
    this.state.acceptWebSocket(server);
    // The challenge must outlive an eviction: its bytes go into the attachment, and it is rebuilt from them.
    const nonce = random(32);
    const secret = random(32);
    server.serializeAttachment({ agentId, nonce: toBase64Url(nonce), secret: toBase64Url(secret), registered: false, since: Date.now() } satisfies Attachment);
    server.send(new RegistrationChallenge(nonce, secret).frame());
    await this.scheduleAlarm(Date.now() + this.limits.registerTimeoutMs);
    return this.runtime.upgradeResponse(client);
  }

  /** Closes the oldest unproven sockets until a new one fits into MAX_PENDING_PER_OBJECT. */
  private makeRoomForPending(): void {
    const pending = this.state
      .getWebSockets()
      .map((socket) => ({ socket, attachment: socket.deserializeAttachment() as Attachment | null }))
      .filter(({ attachment }) => attachment !== null && !attachment.registered && attachment.nonce !== undefined)
      .sort((a, b) => a.attachment!.since - b.attachment!.since);
    for (const { socket } of pending.slice(0, Math.max(0, pending.length - MAX_PENDING_PER_OBJECT + 1))) {
      forgetChallenge(socket);
      socket.close(RelayClose.RegistrationTimeout, 'evicted');
    }
  }

  /** One alarm per object: never move an earlier, sooner one later (a stream of connects would otherwise postpone every timeout). */
  private async scheduleAlarm(at: number): Promise<void> {
    const current = await this.state.storage.getAlarm();
    if (current === null || current > at) {
      await this.state.storage.setAlarm(at);
    }
  }

  private async call(request: Request): Promise<Response> {
    const declared = Number(request.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > this.limits.maxRequestBytes) {
      return refuse('RELAY_TOO_LARGE');
    }
    const body = new Uint8Array(await request.arrayBuffer());
    if (body.length > this.limits.maxRequestBytes) {
      return refuse('RELAY_TOO_LARGE');
    }
    if (body.length === 0) {
      return refuse('RELAY_BAD_REQUEST');
    }
    const socket = this.registered();
    if (!socket) {
      return refuse('RELAY_AGENT_OFFLINE');
    }
    const result = await this.link(socket).call(body);
    this.saveRates(socket);
    if (result.kind === 'error') {
      return refuse(result.code);
    }
    return new Response(result.body, {
      status: result.status,
      headers: { 'content-type': result.status === 200 ? 'application/octet-stream' : 'application/json', 'cache-control': 'no-store' },
    });
  }

  async webSocketMessage(socket: HibernatableSocket, message: ArrayBuffer | string): Promise<void> {
    if (typeof message === 'string') {
      return; // "ping" never gets here (auto response); anything else is ignored
    }
    const attachment = socket.deserializeAttachment() as Attachment;
    const bytes = new Uint8Array(message);
    if (!attachment.registered && !attachment.nonce) {
      return; // timed out, evicted or failed: no late registration
    }
    if (!attachment.registered) {
      this.register(socket, attachment, bytes);
      return;
    }
    try {
      this.link(socket).onFrame(decodeFrame(bytes));
    } catch (err) {
      if (!(err instanceof RelayFrameError)) {
        throw err;
      }
      socket.close(RelayClose.Protocol, 'bad frame');
    }
  }

  /** Checks the proof; the newest registered socket wins, older ones are replaced. */
  private register(socket: HibernatableSocket, attachment: Attachment, proof: Uint8Array): void {
    const challenge = new RegistrationChallenge(fromBase64Url(attachment.nonce!), fromBase64Url(attachment.secret!));
    const outcome = checkRegistration(challenge, proof, attachment.agentId);
    if (!outcome.ok) {
      // Clear the challenge first: the socket closes, but a proof must never get a second try.
      forgetChallenge(socket);
      socket.close(outcome.close, outcome.reason);
      return;
    }
    for (const other of this.state.getWebSockets()) {
      if (other !== socket && (other.deserializeAttachment() as Attachment | null)?.registered) {
        this.links.get(other)?.shutdown();
        this.links.delete(other);
        other.close(RelayClose.Replaced, 'replaced');
      }
    }
    socket.serializeAttachment({ agentId: attachment.agentId, registered: true, since: attachment.since } satisfies Attachment);
    socket.send(encodeFrame(FrameType.Ready, 0, new TextEncoder().encode(JSON.stringify(this.link(socket).info()))));
  }

  async webSocketClose(socket: HibernatableSocket): Promise<void> {
    this.links.get(socket)?.shutdown();
    this.links.delete(socket);
  }

  async webSocketError(socket: HibernatableSocket): Promise<void> {
    await this.webSocketClose(socket);
  }

  /** Registration timeout: closes sockets that never proved their key, and comes back for the younger ones. */
  async alarm(): Promise<void> {
    const now = Date.now();
    let next: number | null = null;
    for (const socket of this.state.getWebSockets()) {
      const attachment = socket.deserializeAttachment() as Attachment | null;
      if (!attachment || attachment.registered || !attachment.nonce) {
        continue;
      }
      const due = attachment.since + this.limits.registerTimeoutMs;
      if (due <= now) {
        forgetChallenge(socket);
        socket.close(RelayClose.RegistrationTimeout, 'no proof');
      } else {
        next = next === null ? due : Math.min(next, due);
      }
    }
    if (next !== null) {
      await this.state.storage.setAlarm(next);
    }
  }

  /**
   * The newest registered socket, if it is alive. No timer watches for idle
   * agents (it would wake every object every minute); a socket whose last
   * heartbeat is older than the idle timeout is found out when a call needs it.
   */
  private registered(): HibernatableSocket | null {
    const sockets = this.state.getWebSockets().filter((s) => (s.deserializeAttachment() as Attachment | null)?.registered);
    const socket = sockets.at(-1) ?? null;
    if (!socket) {
      return null;
    }
    const heard = this.state.getWebSocketAutoResponseTimestamp(socket)?.getTime() ?? (socket.deserializeAttachment() as Attachment).since;
    if (Date.now() - heard > this.limits.idleTimeoutMs) {
      socket.close(RelayClose.Idle, 'idle');
      return null;
    }
    return socket;
  }

  /** The socket's link, rebuilt with the saved rate limits after a hibernation. */
  private link(socket: HibernatableSocket): AgentLink {
    let link = this.links.get(socket);
    if (!link) {
      const { rates } = socket.deserializeAttachment() as Attachment;
      const push = this.push
        ? { send: this.push.send, burst: this.push.config.agentBurst, perHour: this.push.config.agentPerHour, maxInFlight: this.push.config.maxInFlight, done: () => this.saveRates(socket) }
        : null;
      link = new AgentLink({ send: (bytes) => socket.send(bytes), close: (code, reason) => socket.close(code, reason) }, this.limits, { rates, push });
      this.links.set(socket, link);
    }
    return link;
  }

  /**
   * Called when a call has ended. Everything that charges the buckets
   * happens while a call is in flight, and a call in flight keeps the
   * object awake, so the state is saved before the object can hibernate.
   */
  private saveRates(socket: HibernatableSocket): void {
    const link = this.links.get(socket);
    const attachment = socket.deserializeAttachment() as Attachment | null;
    if (!link || !attachment?.registered) {
      return;
    }
    try {
      socket.serializeAttachment({ ...attachment, rates: link.rates() } satisfies Attachment);
    } catch {
      // The socket closed meanwhile; its limits end with it.
    }
  }
}

/** An unproven socket that may not register any more keeps its id and time, not its challenge. */
function forgetChallenge(socket: HibernatableSocket): void {
  const attachment = socket.deserializeAttachment() as Attachment;
  socket.serializeAttachment({ agentId: attachment.agentId, registered: false, since: attachment.since } satisfies Attachment);
}

/** The `vars` of the Worker's environment; bindings are objects and are left out. */
export function stringVars(env: Record<string, unknown>): Record<string, string> {
  return Object.fromEntries(Object.entries(env).filter(([, v]) => typeof v === 'string')) as Record<string, string>;
}

/** A relay error as the HTTP API answers it. */
export function refuse(code: RelayErrorCode): Response {
  const { status, body } = relayError(code);
  return new Response(body, { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
}

function random(length: number): Uint8Array {
  const out = new Uint8Array(length);
  crypto.getRandomValues(out);
  return out;
}
