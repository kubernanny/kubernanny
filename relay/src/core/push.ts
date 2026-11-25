import { PushOutcome, PushRequest, pushTokenDigest } from '@kubernanny/protocol';
import { BucketState, TokenBucket } from './limits';

/** WebCrypto's key type; named through `crypto` because the relay compiles without the DOM library. */
type CryptoKey = Awaited<ReturnType<typeof crypto.subtle.importKey>>;

/**
 * Native push on the relay (docs/RELAY.md, "Native push";
 * decisions/0007-native-push.md): an agent sends a Push frame over its own
 * registered WebSocket, the relay hands it to Firebase Cloud Messaging
 * HTTP v1, and FCM forwards it to the phone (through APNs for iOS).
 *
 * The relay holds the FCM service account; the agent never does. What it
 * forwards is sealed for the device (protocol/src/push.ts): the relay and
 * Google see a token, a key id, a size and a time, never a word of it.
 *
 * Shared by the Node relay and the Cloudflare Worker: WebCrypto signs the
 * Google OAuth assertion (RS256) on both, `fetch` sends.
 */

export interface PushConfig {
  /** Off unless a service account is configured, and RELAY_PUSH=off turns it off even then. */
  enabled: boolean;
  account: ServiceAccount | null;
  /** Per agent: burst and refill per hour. */
  agentBurst: number;
  agentPerHour: number;
  /** Per FCM token, across every agent of this relay (on a Worker: across all objects, through the token limiter object). */
  tokenPerHour: number;
  /** Distinct FCM tokens one agent may push to within a day. */
  tokensPerDay: number;
  /** Per client address of the agents' connections, all its agents together (Node only). */
  addressPerHour: number;
  /** The whole relay (Node only): the bound on what it sends to FCM, however many ids and addresses are used. */
  relayPerHour: number;
  /** Pushes one agent may have waiting for FCM at once. */
  maxInFlight: number;
}

export interface ServiceAccount {
  clientEmail: string;
  privateKey: string;
  projectId: string;
  tokenUri: string;
}

export const DEFAULT_PUSH = { agentBurst: 20, agentPerHour: 60, tokenPerHour: 30, tokensPerDay: 32, addressPerHour: 240, relayPerHour: 20_000, maxInFlight: 4 } as const;
const GOOGLE_TOKEN_URI = 'https://oauth2.googleapis.com/token';
const FCM_SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';
/** Tokens kept for the per-token limit; past this the least recently used goes. */
const MAX_TRACKED_TOKENS = 20_000;

/**
 * RELAY_PUSH (`off` disables), FCM_SERVICE_ACCOUNT (the service account's
 * JSON key, from a Secret), RELAY_PUSHES_PER_HOUR, RELAY_PUSH_BURST,
 * RELAY_PUSHES_PER_TOKEN_PER_HOUR, RELAY_PUSH_TOKENS_PER_DAY,
 * RELAY_PUSHES_PER_ADDRESS_PER_HOUR, RELAY_PUSHES_TOTAL_PER_HOUR. A service account that does not parse
 * stops the start: a relay that silently dropped every push would look
 * like a working one.
 */
export function parsePushConfig(env: Record<string, string | undefined>): PushConfig {
  const switchValue = (env['RELAY_PUSH'] ?? '').trim().toLowerCase();
  if (!['', 'on', 'off', 'true', 'false', '1', '0'].includes(switchValue)) {
    throw new Error(`RELAY_PUSH must be on or off, got "${env['RELAY_PUSH']}"`);
  }
  const off = ['off', 'false', '0'].includes(switchValue);
  const raw = env['FCM_SERVICE_ACCOUNT'];
  const account = raw && !off ? parseServiceAccount(raw) : null;
  const num = (name: string, fallback: number) => {
    const value = env[name] === undefined || env[name] === '' ? fallback : Number(env[name]);
    if (!Number.isFinite(value) || value <= 0) {
      throw new Error(`${name} must be a positive number, got "${env[name]}"`);
    }
    return value;
  };
  return {
    enabled: account !== null,
    account,
    agentBurst: num('RELAY_PUSH_BURST', DEFAULT_PUSH.agentBurst),
    agentPerHour: num('RELAY_PUSHES_PER_HOUR', DEFAULT_PUSH.agentPerHour),
    tokenPerHour: num('RELAY_PUSHES_PER_TOKEN_PER_HOUR', DEFAULT_PUSH.tokenPerHour),
    tokensPerDay: num('RELAY_PUSH_TOKENS_PER_DAY', DEFAULT_PUSH.tokensPerDay),
    addressPerHour: num('RELAY_PUSHES_PER_ADDRESS_PER_HOUR', DEFAULT_PUSH.addressPerHour),
    relayPerHour: num('RELAY_PUSHES_TOTAL_PER_HOUR', DEFAULT_PUSH.relayPerHour),
    maxInFlight: DEFAULT_PUSH.maxInFlight,
  };
}

export function parseServiceAccount(json: string): ServiceAccount {
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(json) as Record<string, unknown>;
  } catch {
    throw new Error('FCM_SERVICE_ACCOUNT is not JSON (expected the service account key file)');
  }
  const { client_email, private_key, project_id, token_uri } = raw ?? {};
  if (typeof client_email !== 'string' || typeof private_key !== 'string' || !private_key.includes('PRIVATE KEY') || typeof project_id !== 'string' || !/^[a-z0-9-]{4,40}$/.test(project_id)) {
    throw new Error('FCM_SERVICE_ACCOUNT needs client_email, private_key and project_id');
  }
  // Only Google's own token endpoint: the assertion is a credential, and a key file pointing elsewhere would hand it out.
  const tokenUri = typeof token_uri === 'string' && token_uri === GOOGLE_TOKEN_URI ? token_uri : GOOGLE_TOKEN_URI;
  return { clientEmail: client_email, privateKey: private_key, projectId: project_id, tokenUri };
}

/** The generic iOS alert, in the agent's language. It names nothing about the cluster. */
const FALLBACK = {
  en: { title: 'Kubernanny', body: 'New status from a cluster. Open Kubernanny to see it.' },
  de: { title: 'Kubernanny', body: 'Neuer Status eines Clusters. Öffne Kubernanny, um ihn zu sehen.' },
} as const;

/**
 * The FCM v1 message. Android gets a data-only message at high priority
 * (never a `notification` block, which the system would show without the
 * app's code), so the app's own messaging service runs, opens it and shows
 * it. iOS gets a generic placeholder alert, always with `mutable-content`,
 * which the Notification Service Extension replaces with the opened text;
 * if it cannot open it, the placeholder is what shows.
 *
 * Only the opened text carries the person's authenticity marker
 * (docs/NOTIFICATIONS.md, "Is this push real?"). Whoever holds the service
 * account can still send a message of a different shape that the phone
 * shows on its own; the marker is what tells the two apart.
 */
export function fcmMessage(push: PushRequest): unknown {
  const data = { k: push.kid, m: push.message };
  if (push.platform === 'android') {
    return { message: { token: push.token, data, android: { priority: 'HIGH', ttl: '86400s' } } };
  }
  return {
    message: {
      token: push.token,
      data,
      apns: {
        headers: { 'apns-priority': '10', 'apns-push-type': 'alert', 'apns-expiration': String(Math.floor(Date.now() / 1000) + 86_400) },
        payload: { aps: { alert: FALLBACK[push.lang ?? 'en'], 'mutable-content': 1, sound: 'default' } },
      },
    },
  };
}

/**
 * What an FCM answer means for the agent. Error codes as documented for FCM
 * HTTP v1 (`FcmErrorCode`: UNREGISTERED, INVALID_ARGUMENT, SENDER_ID_MISMATCH,
 * QUOTA_EXCEEDED, UNAVAILABLE, INTERNAL, THIRD_PARTY_AUTH_ERROR). A dead or
 * foreign token is `unregistered`, so the agent forgets it: UNREGISTERED,
 * SENDER_ID_MISMATCH (a token of another Firebase project), and
 * INVALID_ARGUMENT when its BadRequest details name the field
 * `message.token`. Any other INVALID_ARGUMENT is a malformed message
 * (`invalid`), which is the relay's or the agent's fault, not the token's.
 */
export function outcomeOf(status: number, body: unknown): PushOutcome {
  if (status >= 200 && status < 300) {
    return 'sent';
  }
  const error = (body as { error?: { details?: { errorCode?: unknown; fieldViolations?: { field?: unknown }[] }[]; status?: unknown } } | null)?.error;
  const code = error?.details?.find((d) => typeof d?.errorCode === 'string')?.errorCode ?? error?.status;
  const tokenField = error?.details?.some((d) => d?.fieldViolations?.some((v) => v?.field === 'message.token')) ?? false;
  if (status === 404 || code === 'UNREGISTERED' || code === 'SENDER_ID_MISMATCH' || ((code === 'INVALID_ARGUMENT' || status === 400) && tokenField)) {
    return 'unregistered';
  }
  if (status === 429 || code === 'QUOTA_EXCEEDED') {
    return 'rate_limited';
  }
  if (status >= 500 || code === 'UNAVAILABLE' || code === 'INTERNAL') {
    return 'unavailable';
  }
  if (status === 400 || code === 'INVALID_ARGUMENT') {
    return 'invalid';
  }
  return 'failed';
}

type Fetch = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<{ status: number; json(): Promise<unknown> }>;

/** Access tokens per service account, shared by every client in this process or isolate (a Worker's objects come and go). */
const accessTokens = new Map<string, { token: string; until: number }>();
/** Token requests in flight per service account: concurrent pushes wait for one request instead of each signing and fetching (review L6). */
const tokenRequests = new Map<string, Promise<string>>();

/** Sends to FCM HTTP v1 with a service account. */
export class FcmClient {
  private signingKey: Promise<CryptoKey> | null = null;

  constructor(
    private readonly account: ServiceAccount,
    private readonly fetchFn: Fetch = (url, init) => fetch(url, init),
    private readonly now: () => number = Date.now,
  ) {}

  /** One push; a 401 for our own access token (expired early, revoked) gets a fresh token and one more try. */
  async send(push: PushRequest): Promise<PushOutcome> {
    for (let attempt = 0; ; attempt++) {
      let token: string;
      try {
        token = await this.accessToken();
      } catch {
        return 'unavailable';
      }
      try {
        const res = await this.fetchFn(`https://fcm.googleapis.com/v1/projects/${this.account.projectId}/messages:send`, {
          method: 'POST',
          headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
          body: JSON.stringify(fcmMessage(push)),
          signal: AbortSignal.timeout(10_000),
        });
        const body = res.status >= 300 ? await res.json().catch(() => null) : null;
        // THIRD_PARTY_AUTH_ERROR is a 401 too, but about the APNs credentials in Firebase: a new token does not help.
        if (res.status === 401 && !isThirdPartyAuthError(body)) {
          if (accessTokens.get(this.account.clientEmail)?.token === token) {
            accessTokens.delete(this.account.clientEmail);
          }
          if (attempt === 0) {
            continue;
          }
          return 'unavailable';
        }
        return outcomeOf(res.status, body);
      } catch {
        return 'unavailable';
      }
    }
  }

  /** An OAuth access token from a signed JWT assertion (RFC 7523), cached until five minutes before it expires. */
  private accessToken(): Promise<string> {
    const cached = accessTokens.get(this.account.clientEmail);
    if (cached && cached.until > this.now()) {
      return Promise.resolve(cached.token);
    }
    let request = tokenRequests.get(this.account.clientEmail);
    if (!request) {
      request = this.fetchAccessToken().finally(() => tokenRequests.delete(this.account.clientEmail));
      tokenRequests.set(this.account.clientEmail, request);
    }
    return request;
  }

  private async fetchAccessToken(): Promise<string> {
    const assertion = await this.assertion();
    const res = await this.fetchFn(this.account.tokenUri, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: `grant_type=${encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer')}&assertion=${assertion}`,
      signal: AbortSignal.timeout(10_000),
    });
    const body = (await res.json()) as { access_token?: unknown; expires_in?: unknown };
    if (res.status !== 200 || typeof body.access_token !== 'string') {
      throw new Error(`token endpoint answered ${res.status}`);
    }
    const lifetime = typeof body.expires_in === 'number' ? body.expires_in : 3600;
    accessTokens.set(this.account.clientEmail, { token: body.access_token, until: this.now() + Math.max(60, lifetime - 300) * 1000 });
    return body.access_token;
  }

  async assertion(): Promise<string> {
    const iat = Math.floor(this.now() / 1000);
    const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
    const claims = b64url(JSON.stringify({ iss: this.account.clientEmail, scope: FCM_SCOPE, aud: this.account.tokenUri, iat, exp: iat + 3600 }));
    this.signingKey ??= importPkcs8(this.account.privateKey);
    const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', await this.signingKey, new TextEncoder().encode(`${header}.${claims}`));
    return `${header}.${claims}.${b64url(new Uint8Array(signature))}`;
  }
}

function isThirdPartyAuthError(body: unknown): boolean {
  const error = (body as { error?: { details?: { errorCode?: unknown }[] } } | null)?.error;
  return error?.details?.some((d) => d?.errorCode === 'THIRD_PARTY_AUTH_ERROR') ?? false;
}

function importPkcs8(pem: string): Promise<CryptoKey> {
  const der = Uint8Array.from(atob(pem.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '')), (c) => c.charCodeAt(0));
  return crypto.subtle.importKey('pkcs8', der, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
}

function b64url(input: string | Uint8Array): string {
  const bytes = typeof input === 'string' ? new TextEncoder().encode(input) : input;
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * The per-token limit: a stranger who registers an agent of their own and
 * learns someone's FCM token (it is not secret to the relay, and a paired
 * device chooses the token it registers) cannot make that phone buzz more
 * than this, however many agent ids they register on this relay.
 *
 * Bounded without being cheap to reset (review M3): when the table is full,
 * only the least recently used entry goes, and only if its bucket has
 * refilled completely (forgetting it then changes nothing). If not, the new
 * token is refused until one has. Filling the table therefore takes
 * `maxTokens` pushes within a refill period, which the relay-wide push
 * budget does not allow by default. Keyed by digest: no token is held.
 */
export class TokenLimiter {
  private readonly buckets = new Map<string, TokenBucket>();

  constructor(
    private readonly perHour: number,
    private readonly now: () => number = Date.now,
    private readonly maxTokens = MAX_TRACKED_TOKENS,
  ) {}

  take(token: string): boolean {
    const now = this.now();
    const digest = pushTokenDigest(token);
    let bucket = this.buckets.get(digest);
    if (bucket) {
      this.buckets.delete(digest); // re-inserted below: the Map's order is the least recently used first
    } else {
      if (this.buckets.size >= this.maxTokens) {
        const [oldest, oldestBucket] = this.buckets.entries().next().value!;
        if (!oldestBucket.isFull(now)) {
          return false;
        }
        this.buckets.delete(oldest);
      }
      bucket = tokenBucket(this.perHour, now);
    }
    this.buckets.set(digest, bucket);
    return bucket.takeExact(1, now);
  }
}

/** One token's bucket: a sixth of the hour's pushes as burst. */
export function tokenBucket(perHour: number, now: number, saved?: BucketState): TokenBucket {
  return new TokenBucket(Math.max(1, Math.ceil(perHour / 6)), perHour / 3_600_000, now, saved);
}

/** Where the per-token limit lives: in this process (Node), or in a Durable Object per token (Worker). */
export interface TokenGate {
  take(token: string): boolean | Promise<boolean>;
}

/** What an AgentLink calls for a Push frame: per-token limit, then FCM. */
export type PushSender = (push: PushRequest) => Promise<PushOutcome>;

export function pushSender(config: PushConfig, client: FcmClient | null = config.account ? new FcmClient(config.account) : null, tokens: TokenGate = new TokenLimiter(config.tokenPerHour)): PushSender | null {
  if (!config.enabled || !client) {
    return null;
  }
  return async (push) => {
    let allowed: boolean;
    try {
      allowed = await tokens.take(push.token);
    } catch {
      return 'unavailable'; // the limiter could not be asked: fail closed
    }
    return allowed ? client.send(push) : 'rate_limited';
  };
}
