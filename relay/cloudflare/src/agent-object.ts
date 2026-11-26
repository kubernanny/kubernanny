/**
 * One Durable Object per agent id: it holds the agent's WebSocket and
 * forwards the calls for that id to it. Same frames, same registration
 * proof, same registration states (`core/session.ts`) and same per-agent
 * limits as the Node relay, from the same code (`relay/src/core`,
 * `@kubernanny/protocol`); docs/RELAY.md lists the relay-wide limits a
 * Worker has no equivalent for.
 *
 * The WebSocket Hibernation API keeps an idle agent free of charge in
 * memory terms: the object is evicted between calls, the socket stays
 * connected at Cloudflare's edge, and the heartbeat ("ping" -> "pong") is
 * answered by the runtime without waking the object. What must survive an
 * eviction (the session, the state of its rate limits) lives in the
 * socket's attachment, not in fields. The push allowance must outlive the
 * socket too (a reconnect must not start it full), so it is also written to
 * the object's storage, one small row per object, after each push.
 */
import { DeadmanDeposit, DepositOutcome, FrameType, RelayClose, RelayFrameError, decodeFrame, encodeFrame, relayOrigin } from '@kubernanny/protocol';
import { AgentLink, LinkRates } from '../../src/core/agent-link';
import { DeadmanConfig, DeadmanState, agentBack, agentLost, depositInto, dueItems, emptyDeadman, expire, fireDue, markSent, nextWake, parseDeadmanConfig } from '../../src/core/deadman';
import { RelayErrorCode, relayError } from '../../src/core/http';
import { RelayLimits, parseLimits } from '../../src/core/limits';
import { PushConfig, PushSender, TokenGate, parsePushConfig, pushSender } from '../../src/core/push';
import { AgentPushPolicy, PushPolicyState } from '../../src/core/push-policy';
import { Session, endSession, newestRegistered, openSession, proveSession, registrationExpired } from '../../src/core/session';

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
  storage: {
    get<T>(key: string): Promise<T | undefined>;
    put<T>(key: string, value: T): Promise<void>;
    delete?(key: string): Promise<boolean>;
    /** The object's one alarm (the dead man's switch; earlier deployments: the registration sweep). */
    setAlarm?(scheduledTime: number): Promise<void>;
    deleteAlarm?(): Promise<void>;
  };
}

/**
 * Unproven sockets one object holds at once. Everything aimed at one agent
 * id lands in one object, so this is the per-id pool; when full the oldest
 * goes, and a real agent, which proves its key in one round trip, still
 * gets in during a flood.
 */
export const MAX_PENDING_PER_OBJECT = 4;

interface Attachment {
  session: Session;
  /**
   * The link's token buckets after its last call. A woken object builds a
   * new link, which would otherwise start with full buckets and never reach
   * the hourly byte cap. Written to the attachment, not to storage: it costs
   * no billed write and lives exactly as long as the socket, as the link
   * does on the Node relay.
   */
  rates?: LinkRates;
  /** The push allowance, read from storage at registration and saved after each push. */
  push?: PushPolicyState;
}

/** Storage key of the agent's push allowance. */
const PUSH_KEY = 'push';
/** Storage key of the dead man's switch (core/deadman.ts): the deposit, the absence, what went out. */
const DEADMAN_KEY = 'deadman';
/**
 * While the agent is connected and a deposit is held, the alarm looks this
 * often whether the agent is still heard: a hibernated socket whose peer
 * vanished (power cut, network gone) is not always reported as closed, and
 * the heartbeat is answered by the runtime without waking the object. The
 * absence counts from the last heartbeat, so a grace of 10 minutes still
 * holds; the cost is one alarm per agent with a deposit every 5 minutes.
 */
export const DEADMAN_CHECK_MS = 5 * 60_000;

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
  /** Registration timeouts while awake. In memory, not an alarm: an unauthenticated connect must not cost a storage write (review L2). */
  private readonly timers = new Map<HibernatableSocket, ReturnType<typeof setTimeout>>();
  /** RELAY_PUBLIC_URL as an origin; else the origin each connect request was routed to. */
  private readonly publicOrigin: string | null;
  /** Native push (secret FCM_SERVICE_ACCOUNT, RELAY_PUSH): null when off. */
  private readonly push: { config: PushConfig; send: PushSender } | null;
  private readonly deadman: DeadmanConfig;
  /** The stored dead man's switch state while awake; read again after a hibernation. Changes go through `saveDeadman`. */
  private deadmanState: Promise<DeadmanState> | null = null;

  constructor(
    private readonly state: AgentObjectState,
    env: Record<string, unknown>,
    private readonly runtime: Runtime,
    /** Tests pass a fake FCM; the Worker sends to the real one. */
    send?: PushSender,
    /** The per-token limit; the Worker passes one backed by the token limiter object, so it holds across all agents. */
    tokens?: TokenGate,
  ) {
    const vars = stringVars(env);
    this.limits = parseLimits(vars);
    this.publicOrigin = vars['RELAY_PUBLIC_URL'] ? relayOrigin(vars['RELAY_PUBLIC_URL']) : null;
    const config = parsePushConfig(vars);
    const sender = config.enabled ? (send ?? pushSender(config, undefined, tokens)) : null;
    this.push = sender ? { config, send: sender } : null;
    this.deadman = parseDeadmanConfig(vars, this.push !== null);
    state.setWebSocketAutoResponse(runtime.autoResponse('ping', 'pong'));
  }

  /** `connect` from the agent (an upgrade) or `call` from the app; the Worker already checked the route. */
  async fetch(request: Request, kind: 'connect' | 'call', agentId: string): Promise<Response> {
    return kind === 'connect' ? this.connect(request, agentId) : this.call(request);
  }

  private connect(request: Request, agentId: string): Response {
    this.closeExpired(Date.now());
    this.makeRoomForPending();
    const [client, server] = this.runtime.newSocketPair();
    this.state.acceptWebSocket(server);
    // Cloudflare routes by host, so the request's own origin is a host of this Worker that the agent dialled.
    const origin = this.publicOrigin ?? relayOrigin(request.url);
    const { session, challenge } = openSession(agentId, origin, Date.now());
    server.serializeAttachment({ session } satisfies Attachment);
    server.send(challenge);
    this.timers.set(
      server,
      setTimeout(() => this.closeExpired(Date.now()), this.limits.registerTimeoutMs + 50),
    );
    return this.runtime.upgradeResponse(client);
  }

  /** Closes the oldest unproven sockets until a new one fits into MAX_PENDING_PER_OBJECT. */
  private makeRoomForPending(): void {
    const pending = this.sockets()
      .filter(({ attachment }) => attachment?.session.phase === 'pending')
      .sort((a, b) => a.attachment!.session.since - b.attachment!.session.since);
    for (const { socket } of pending.slice(0, Math.max(0, pending.length - MAX_PENDING_PER_OBJECT + 1))) {
      this.end(socket, RelayClose.RegistrationTimeout, 'evicted');
    }
  }

  /**
   * Unproven sockets past the registration timeout. Run by the in-memory
   * timer while the object is awake, and on every connect: an object that
   * hibernated with an unproven socket closes it at the next connect (or the
   * proof is refused as late), and holds at most MAX_PENDING_PER_OBJECT meanwhile.
   */
  private closeExpired(now: number): void {
    for (const { socket, attachment } of this.sockets()) {
      if (attachment && registrationExpired(attachment.session, now, this.limits.registerTimeoutMs)) {
        this.end(socket, RelayClose.RegistrationTimeout, 'no proof');
      }
    }
  }

  private async call(request: Request): Promise<Response> {
    // Nobody to give it to: answered before a byte of the body is read (review M2).
    const socket = this.registered();
    if (!socket) {
      return refuse('RELAY_AGENT_OFFLINE');
    }
    const body = await readLimited(request, this.limits.maxRequestBytes);
    if (body === 'too large') {
      return refuse('RELAY_TOO_LARGE');
    }
    if (body.length === 0) {
      return refuse('RELAY_BAD_REQUEST');
    }
    // CF-Connecting-IP is set by Cloudflare itself, so a caller cannot pick a fresh share (review M1).
    const result = await this.link(socket).call(body, request.headers.get('cf-connecting-ip') ?? 'unknown');
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
    const attachment = socket.deserializeAttachment() as Attachment | null;
    if (!attachment) {
      return;
    }
    const bytes = new Uint8Array(message);
    if (attachment.session.phase === 'pending') {
      await this.register(socket, attachment, bytes);
      return;
    }
    if (attachment.session.phase !== 'registered') {
      return; // timed out, evicted, failed or replaced: no late registration, no frames
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

  /** Checks the proof; the newest registered socket wins, older ones are replaced and marked as no longer registered (review L1). */
  private async register(socket: HibernatableSocket, attachment: Attachment, proof: Uint8Array): Promise<void> {
    this.clearTimer(socket);
    if (registrationExpired(attachment.session, Date.now(), this.limits.registerTimeoutMs)) {
      this.end(socket, RelayClose.RegistrationTimeout, 'no proof');
      return;
    }
    const { session, outcome } = proveSession(attachment.session, proof, Date.now());
    // The new state first: the socket closes, but a proof must never get a second try.
    socket.serializeAttachment({ session } satisfies Attachment);
    if (outcome && !outcome.ok) {
      socket.close(outcome.close, outcome.reason);
      return;
    }
    for (const { socket: other, attachment: theirs } of this.sockets()) {
      if (other !== socket && theirs?.session.phase === 'registered') {
        this.links.get(other)?.shutdown();
        this.links.delete(other);
        this.end(other, RelayClose.Replaced, 'replaced');
      }
    }
    const push = this.push ? await this.state.storage.get<PushPolicyState>(PUSH_KEY).catch(() => undefined) : undefined;
    try {
      socket.serializeAttachment({ session, push } satisfies Attachment);
    } catch {
      return; // closed while storage answered
    }
    const fired = await this.deadmanBack();
    socket.send(encodeFrame(FrameType.Ready, 0, new TextEncoder().encode(JSON.stringify({ ...this.link(socket).info(), ...(fired ? { deadmanFired: fired } : {}) }))));
  }

  async webSocketClose(socket: HibernatableSocket): Promise<void> {
    this.clearTimer(socket);
    this.links.get(socket)?.shutdown();
    this.links.delete(socket);
    // The agent's current connection went away (not one replaced by a newer one): the dead man's switch arms.
    const attachment = socket.deserializeAttachment() as Attachment | null;
    if (attachment?.session.phase === 'registered' && !this.sockets().some(({ socket: other, attachment: theirs }) => other !== socket && theirs?.session.phase === 'registered')) {
      await this.deadmanLost(this.heardAt(socket, attachment));
    }
  }

  async webSocketError(socket: HibernatableSocket): Promise<void> {
    await this.webSocketClose(socket);
  }

  /**
   * The dead man's switch's alarm (and, for objects of an earlier
   * deployment, the registration sweep). While the agent is connected it
   * checks that it is still heard; once it is away it sends what is due.
   */
  async alarm(): Promise<void> {
    const now = Date.now();
    this.closeExpired(now);
    if (!this.push || !this.deadman.enabled) {
      return;
    }
    let state = expire(await this.loadDeadman(), now);
    if (state.lostAt === null && state.items.length > 0) {
      const newest = newestRegistered(this.sockets(), ({ attachment }) => attachment?.session ?? null);
      if (!newest) {
        // No registered socket and no close reported (the runtime restarted the object): away since now at the latest.
        state = agentLost(state, now);
      } else {
        const heard = this.heardAt(newest.socket, newest.attachment!);
        if (now - heard > this.limits.idleTimeoutMs) {
          this.end(newest.socket, RelayClose.Idle, 'idle');
          state = agentLost(state, heard);
        }
      }
    }
    const due = dueItems(state, now);
    state = markSent(state, due);
    await this.saveDeadman(state);
    if (due.length > 0) {
      const saved = await this.state.storage.get<PushPolicyState>(PUSH_KEY).catch(() => undefined);
      const config = this.push.config;
      const policy = new AgentPushPolicy({ burst: config.agentBurst, perHour: config.agentPerHour, tokensPerDay: config.tokensPerDay }, now, saved);
      await fireDue(due, { send: this.push.send, allows: (d, at) => policy.allows(d, at), charge: (d, at) => policy.charge(d, at) }, now);
      await this.state.storage.put(PUSH_KEY, policy.state()).catch(() => undefined);
    }
    await this.scheduleDeadman(state, now);
  }

  /** The time a socket was last heard: its last heartbeat, else when it connected. */
  private heardAt(socket: HibernatableSocket, attachment: Attachment): number {
    return this.state.getWebSocketAutoResponseTimestamp(socket)?.getTime() ?? attachment.session.since;
  }

  private loadDeadman(): Promise<DeadmanState> {
    this.deadmanState ??= this.state.storage
      .get<DeadmanState>(DEADMAN_KEY)
      .then((saved) => saved ?? emptyDeadman())
      .catch(() => emptyDeadman());
    return this.deadmanState;
  }

  private async saveDeadman(state: DeadmanState): Promise<void> {
    this.deadmanState = Promise.resolve(state);
    await this.state.storage.put(DEADMAN_KEY, state).catch(() => undefined);
  }

  /** The next alarm: a check every DEADMAN_CHECK_MS while connected, the next message due while away, nothing without a deposit. */
  private async scheduleDeadman(state: DeadmanState, now: number): Promise<void> {
    const wake = nextWake(state);
    if (wake === null) {
      await this.state.storage.deleteAlarm?.().catch(() => undefined);
      return;
    }
    const at = state.lostAt === null ? Math.min(wake, now + DEADMAN_CHECK_MS) : wake;
    await this.state.storage.setAlarm?.(Math.max(now + 1, at)).catch(() => undefined);
  }

  /** A Deposit frame: stored with the object, replacing the one before. */
  private async deadmanDeposit(socket: HibernatableSocket, deposit: DeadmanDeposit | null): Promise<DepositOutcome> {
    const now = Date.now();
    if ((socket.deserializeAttachment() as Attachment | null)?.session.phase !== 'registered') {
      return 'disabled';
    }
    const { state, outcome } = depositInto(expire(await this.loadDeadman(), now), deposit, this.deadman, now);
    await this.saveDeadman(state);
    await this.scheduleDeadman(state, now);
    return outcome;
  }

  private async deadmanLost(heardAt: number): Promise<void> {
    if (!this.push || !this.deadman.enabled) {
      return;
    }
    const before = await this.loadDeadman();
    if (before.items.length === 0) {
      return;
    }
    const state = agentLost(before, heardAt);
    await this.saveDeadman(state);
    await this.scheduleDeadman(state, Date.now());
  }

  /** A connection registered: disarmed, and what went out while the agent was away goes into its Ready. */
  private async deadmanBack(): Promise<{ k: string[]; m: number } | null> {
    if (!this.push || !this.deadman.enabled) {
      return null;
    }
    const before = await this.loadDeadman();
    if (before.items.length === 0 && before.fired === null && before.lostAt === null) {
      return null;
    }
    const now = Date.now();
    const { state, fired } = agentBack(before, now);
    await this.saveDeadman(state);
    await this.scheduleDeadman(state, now);
    return fired;
  }

  /**
   * The newest registered socket (largest `registeredAt`), if it is alive.
   * No timer watches for idle agents (it would wake every object every
   * minute); a socket whose last heartbeat is older than the idle timeout
   * is found out when a call needs it.
   */
  private registered(): HibernatableSocket | null {
    const newest = newestRegistered(this.sockets(), ({ attachment }) => attachment?.session ?? null);
    if (!newest) {
      return null;
    }
    const { socket, attachment } = newest;
    const heard = this.heardAt(socket, attachment!);
    if (Date.now() - heard > this.limits.idleTimeoutMs) {
      this.end(socket, RelayClose.Idle, 'idle');
      void this.deadmanLost(heard);
      return null;
    }
    return socket;
  }

  /** The socket's link, rebuilt with the saved rate limits and push allowance after a hibernation. */
  private link(socket: HibernatableSocket): AgentLink {
    let link = this.links.get(socket);
    if (!link) {
      const { rates, push: saved } = socket.deserializeAttachment() as Attachment;
      let push = null;
      if (this.push) {
        const config = this.push.config;
        const policy = new AgentPushPolicy({ burst: config.agentBurst, perHour: config.agentPerHour, tokensPerDay: config.tokensPerDay }, Date.now(), saved);
        push = { send: this.push.send, policy, maxInFlight: config.maxInFlight, done: () => this.savePush(socket, policy) };
      }
      // A Workers WebSocket queues nothing the object can see: a frame counts as sent once handed over.
      const deadman = push && this.deadman.enabled ? { deposit: (deposit: DeadmanDeposit | null) => this.deadmanDeposit(socket, deposit) } : null;
      link = new AgentLink({ send: (bytes, sent) => (socket.send(bytes), sent?.()), close: (code, reason) => socket.close(code, reason) }, this.limits, { rates, push, deadman });
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
    if (!link || attachment?.session.phase !== 'registered') {
      return;
    }
    try {
      socket.serializeAttachment({ ...attachment, rates: link.rates() } satisfies Attachment);
    } catch {
      // The socket closed meanwhile; its limits end with it.
    }
  }

  /** After each push: the allowance into the attachment (for the next wake-up) and into storage (for the next connection). */
  private savePush(socket: HibernatableSocket, policy: AgentPushPolicy): void {
    const state = policy.state();
    void this.state.storage.put(PUSH_KEY, state).catch(() => undefined);
    const attachment = socket.deserializeAttachment() as Attachment | null;
    if (attachment?.session.phase === 'registered') {
      try {
        socket.serializeAttachment({ ...attachment, push: state } satisfies Attachment);
      } catch {
        // closed meanwhile
      }
    }
  }

  private sockets(): { socket: HibernatableSocket; attachment: Attachment | null }[] {
    return this.state.getWebSockets().map((socket) => ({ socket, attachment: socket.deserializeAttachment() as Attachment | null }));
  }

  /** Ends the socket's session (so it never registers, or counts as registered, again) and closes it. */
  private end(socket: HibernatableSocket, code: number, reason: string): void {
    this.clearTimer(socket);
    const attachment = socket.deserializeAttachment() as Attachment | null;
    if (attachment) {
      try {
        socket.serializeAttachment({ session: endSession(attachment.session) } satisfies Attachment);
      } catch {
        // already closed
      }
    }
    socket.close(code, reason);
  }

  private clearTimer(socket: HibernatableSocket): void {
    const timer = this.timers.get(socket);
    if (timer !== undefined) {
      clearTimeout(timer);
      this.timers.delete(socket);
    }
  }
}

/** The request body, read through a counting reader that stops one byte past `limit` (review M2: a chunked body has no content-length). */
export async function readLimited(request: Request, limit: number): Promise<Uint8Array | 'too large'> {
  const declared = Number(request.headers.get('content-length') ?? Number.NaN);
  if (Number.isFinite(declared) && declared > limit) {
    return 'too large';
  }
  if (!request.body) {
    return new Uint8Array(0);
  }
  const reader = request.body.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel().catch(() => undefined);
      return 'too large';
    }
    parts.push(value);
  }
  const out = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
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
