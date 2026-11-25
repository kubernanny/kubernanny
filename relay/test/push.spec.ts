import { FrameType, PushRequest, decodeFrame, decodePushResult, encodeFrame, encodePushRequest, toBase64Url } from '@kubernanny/protocol';
import { describe, expect, it, vi } from 'vitest';
import { AgentLink, LinkPush, LinkSocket } from '../src/core/agent-link';
import { DEFAULT_LIMITS } from '../src/core/limits';
import { FcmClient, ServiceAccount, TokenLimiter, fcmMessage, outcomeOf, parsePushConfig, parseServiceAccount, pushSender } from '../src/core/push';

const accountJson = (overrides: Record<string, unknown> = {}) =>
  JSON.stringify({ client_email: 'relay@kubernanny-test.iam.gserviceaccount.com', private_key: '-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----\n', project_id: 'kubernanny-test', ...overrides });

const request = (overrides: Partial<PushRequest> = {}): PushRequest => ({
  token: 'dGVzdC10b2tlbi1mb3ItZmNt:APA91bHPRgkF',
  platform: 'android',
  kid: 'AbCdEfGhIjKlMnOp',
  message: toBase64Url(new Uint8Array(120).fill(7)),
  ...overrides,
});

describe('push configuration', () => {
  it('is off without a service account, and RELAY_PUSH=off turns it off with one', () => {
    expect(parsePushConfig({}).enabled).toBe(false);
    expect(parsePushConfig({ FCM_SERVICE_ACCOUNT: accountJson() }).enabled).toBe(true);
    const off = parsePushConfig({ FCM_SERVICE_ACCOUNT: accountJson(), RELAY_PUSH: 'off' });
    expect(off.enabled).toBe(false);
    expect(off.account).toBeNull();
    expect(pushSender(off)).toBeNull();
  });

  it('fails the start on a broken key file or switch, and has fair-use defaults', () => {
    expect(() => parsePushConfig({ FCM_SERVICE_ACCOUNT: '{nope' })).toThrow(/JSON/);
    expect(() => parsePushConfig({ FCM_SERVICE_ACCOUNT: accountJson({ project_id: undefined }) })).toThrow(/project_id/);
    expect(() => parsePushConfig({ RELAY_PUSH: 'maybe' })).toThrow(/RELAY_PUSH/);
    expect(parsePushConfig({})).toMatchObject({ agentBurst: 20, agentPerHour: 60, tokenPerHour: 30 });
    expect(parsePushConfig({ RELAY_PUSHES_PER_HOUR: '10' }).agentPerHour).toBe(10);
  });

  it('only ever sends the assertion to Google, whatever the key file says', () => {
    expect(parseServiceAccount(accountJson({ token_uri: 'https://evil.example/token' })).tokenUri).toBe('https://oauth2.googleapis.com/token');
  });
});

describe('the FCM message', () => {
  it('is data only on Android: key id and sealed bytes, nothing else', () => {
    expect(fcmMessage(request())).toEqual({ message: { token: request().token, data: { k: request().kid, m: request().message }, android: { priority: 'HIGH', ttl: '86400s' } } });
  });

  it('is a generic, mutable alert on iOS, in the agent language', () => {
    const message = fcmMessage(request({ platform: 'ios', lang: 'de' })) as { message: { apns: { payload: { aps: Record<string, unknown> } }; data: unknown } };
    expect(message.message.data).toEqual({ k: request().kid, m: request().message });
    expect(message.message.apns.payload.aps['mutable-content']).toBe(1);
    expect(message.message.apns.payload.aps['alert']).toEqual({ title: 'Kubernanny', body: expect.stringContaining('Öffne Kubernanny') });
  });

  // A `notification` block would be shown by Android without the app's code, and an APNs alert
  // without mutable-content by iOS without the extension: legitimate pushes never take that path,
  // so the authenticity marker the app adds can only appear on a push that really opened.
  it('never carries a notification block, and the iOS alert always goes through the extension', () => {
    for (const platform of ['android', 'ios'] as const) {
      for (const lang of [undefined, 'en', 'de'] as const) {
        const message = fcmMessage(request({ platform, ...(lang ? { lang } : {}) })) as { message: Record<string, unknown> & { android?: Record<string, unknown>; apns?: { payload: { aps: Record<string, unknown> } } } };
        expect(message.message).not.toHaveProperty('notification');
        expect(Object.keys(message.message.data as object).sort()).toEqual(['k', 'm']);
        if (platform === 'android') {
          expect(message.message.android).toEqual({ priority: 'HIGH', ttl: '86400s' });
          expect(message.message).not.toHaveProperty('apns');
        } else {
          expect(message.message).not.toHaveProperty('android');
          const aps = message.message.apns!.payload.aps;
          expect(aps['mutable-content']).toBe(1);
          expect(Object.keys(aps).sort()).toEqual(['alert', 'mutable-content', 'sound']);
          // The placeholder names nothing the relay could know about the cluster.
          expect(JSON.stringify(aps['alert'])).not.toMatch(/homelab|problem|default\//i);
        }
      }
    }
  });

  it('maps FCM answers to outcomes', () => {
    expect(outcomeOf(200, null)).toBe('sent');
    expect(outcomeOf(404, null)).toBe('unregistered');
    expect(outcomeOf(400, { error: { status: 'INVALID_ARGUMENT', details: [{ errorCode: 'UNREGISTERED' }] } })).toBe('unregistered');
    expect(outcomeOf(429, null)).toBe('rate_limited');
    expect(outcomeOf(503, null)).toBe('unavailable');
    expect(outcomeOf(400, { error: { status: 'INVALID_ARGUMENT' } })).toBe('invalid');
    expect(outcomeOf(403, null)).toBe('failed');
  });
});

/** A fake Google: checks the signed assertion with the account's public key, then takes messages. */
async function fakeGoogle() {
  const keys = (await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify'])) as CryptoKeyPair;
  const pkcs8 = Buffer.from(await crypto.subtle.exportKey('pkcs8', keys.privateKey)).toString('base64');
  const account: ServiceAccount = {
    clientEmail: `relay-${Math.random().toString(36).slice(2)}@kubernanny-test.iam.gserviceaccount.com`,
    privateKey: `-----BEGIN PRIVATE KEY-----\n${pkcs8.replace(/(.{64})/g, '$1\n')}\n-----END PRIVATE KEY-----\n`,
    projectId: 'kubernanny-test',
    tokenUri: 'https://oauth2.googleapis.com/token',
  };
  const messages: { url: string; auth: string; body: unknown }[] = [];
  let tokenRequests = 0;
  let fcmStatus = 200;
  const fetchFn = vi.fn(async (url: string, init: { headers: Record<string, string>; body: string }) => {
    if (url === account.tokenUri) {
      tokenRequests++;
      const assertion = new URLSearchParams(init.body).get('assertion')!;
      const [header, claims, signature] = assertion.split('.');
      const valid = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', keys.publicKey, Buffer.from(signature!, 'base64url'), new TextEncoder().encode(`${header}.${claims}`));
      const parsed = JSON.parse(Buffer.from(claims!, 'base64url').toString()) as Record<string, unknown>;
      const ok = valid && parsed['iss'] === account.clientEmail && parsed['scope'] === 'https://www.googleapis.com/auth/firebase.messaging' && parsed['aud'] === account.tokenUri;
      return { status: ok ? 200 : 400, json: async () => (ok ? { access_token: 'ya29.test', expires_in: 3599 } : { error: 'invalid_grant' }) };
    }
    messages.push({ url, auth: init.headers['authorization']!, body: JSON.parse(init.body) });
    return { status: fcmStatus, json: async () => (fcmStatus === 200 ? { name: 'projects/x/messages/1' } : { error: { status: 'NOT_FOUND', details: [{ errorCode: 'UNREGISTERED' }] } }) };
  });
  return { account, messages, fetchFn, tokens: () => tokenRequests, answer: (status: number) => (fcmStatus = status) };
}

describe('FcmClient', () => {
  it('signs a valid RS256 assertion, caches the access token and sends to the project', async () => {
    const google = await fakeGoogle();
    const client = new FcmClient(google.account, google.fetchFn);
    expect(await client.send(request())).toBe('sent');
    expect(await client.send(request({ platform: 'ios' }))).toBe('sent');
    expect(google.tokens()).toBe(1);
    expect(google.messages).toHaveLength(2);
    expect(google.messages[0]!.url).toBe('https://fcm.googleapis.com/v1/projects/kubernanny-test/messages:send');
    expect(google.messages[0]!.auth).toBe('Bearer ya29.test');
    expect(google.messages[0]!.body).toEqual(fcmMessage(request()));
  });

  it('tells the agent when the token is gone', async () => {
    const google = await fakeGoogle();
    google.answer(404);
    expect(await new FcmClient(google.account, google.fetchFn).send(request())).toBe('unregistered');
  });

  it('answers unavailable when Google cannot be reached', async () => {
    const google = await fakeGoogle();
    const client = new FcmClient(google.account, async () => {
      throw new Error('offline');
    });
    expect(await client.send(request())).toBe('unavailable');
  });
});

describe('the per-token limit', () => {
  it('holds across every agent of the relay', async () => {
    const tokens = new TokenLimiter(30, () => 0);
    const sent: string[] = [];
    const send = pushSender(parsePushConfig({ FCM_SERVICE_ACCOUNT: accountJson() }), { send: async (r: PushRequest) => (sent.push(r.token), 'sent' as const) } as unknown as FcmClient, tokens)!;
    const outcomes = [];
    for (let i = 0; i < 8; i++) {
      outcomes.push(await send(request()));
    }
    expect(outcomes.filter((o) => o === 'sent')).toHaveLength(5); // burst: a sixth of the hourly 30
    expect(outcomes.at(-1)).toBe('rate_limited');
    expect(await send(request({ token: 'another-device-token-0123456789' }))).toBe('sent');
  });
});

describe('AgentLink and Push frames', () => {
  const socket = () => {
    const sent: Uint8Array[] = [];
    const s: LinkSocket & { sent: Uint8Array[] } = { sent, send: (b) => sent.push(b.slice()), close: () => undefined };
    return s;
  };
  const results = (s: { sent: Uint8Array[] }) => s.sent.map(decodeFrame).filter((f) => f.type === FrameType.PushResult).map((f) => [f.callId, decodePushResult(f.payload)]);
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

  it('answers disabled and says push: false on a relay without push', async () => {
    const s = socket();
    const link = new AgentLink(s, DEFAULT_LIMITS);
    expect(link.info().push).toBe(false);
    link.onFrame(decodeFrame(encodePushRequest(3, request())));
    expect(results(s)).toEqual([[3, 'disabled']]);
  });

  it('forwards to the sender and answers each id once', async () => {
    const s = socket();
    const send = vi.fn(async () => 'sent' as const);
    const done = vi.fn();
    const link = new AgentLink(s, DEFAULT_LIMITS, { push: { send, burst: 20, perHour: 60, maxInFlight: 4, done } satisfies LinkPush });
    expect(link.info().push).toBe(true);
    link.onFrame(decodeFrame(encodePushRequest(9, request())));
    link.onFrame(decodeFrame(encodePushRequest(9, request()))); // same id while it waits: ignored
    await flush();
    expect(send).toHaveBeenCalledTimes(1);
    expect(results(s)).toEqual([[9, 'sent']]);
    expect(done).toHaveBeenCalled();
  });

  it('refuses malformed pushes and keeps to the agent budget and its pushes in flight', async () => {
    const s = socket();
    let release: () => void = () => undefined;
    const send = vi.fn(() => new Promise<'sent'>((resolve) => (release = () => resolve('sent'))));
    const link = new AgentLink(s, DEFAULT_LIMITS, { push: { send, burst: 3, perHour: 60, maxInFlight: 1 } });
    link.onFrame(decodeFrame(encodeFrame(FrameType.Push, 1, new TextEncoder().encode('{"t":"x"}'))));
    link.onFrame(decodeFrame(encodePushRequest(2, request())));
    link.onFrame(decodeFrame(encodePushRequest(3, request()))); // one in flight already
    release();
    await flush();
    link.onFrame(decodeFrame(encodePushRequest(4, request())));
    release();
    await flush();
    link.onFrame(decodeFrame(encodePushRequest(5, request()))); // the third token of the burst (2, 4, 5; 3 was refused before charging)
    release();
    await flush();
    link.onFrame(decodeFrame(encodePushRequest(6, request())));
    await flush();
    const byId = Object.fromEntries(results(s));
    expect(byId[1]).toBe('invalid');
    expect(byId[2]).toBe('sent');
    expect(byId[3]).toBe('rate_limited');
    expect(byId[4]).toBe('sent');
    expect(byId[5]).toBe('sent');
    expect(byId[6]).toBe('rate_limited');
    expect(send).toHaveBeenCalledTimes(3);
  });

  it('saves the push bucket with the other rates, so a woken Durable Object does not refill it', () => {
    const s = socket();
    const link = new AgentLink(s, DEFAULT_LIMITS, { now: () => 0, push: { send: async () => 'sent', burst: 1, perHour: 1, maxInFlight: 4 } });
    link.onFrame(decodeFrame(encodePushRequest(1, request())));
    const again = new AgentLink(s, DEFAULT_LIMITS, { now: () => 0, rates: link.rates(), push: { send: async () => 'sent', burst: 1, perHour: 1, maxInFlight: 4 } });
    again.onFrame(decodeFrame(encodePushRequest(2, request())));
    expect(results(s)).toContainEqual([2, 'rate_limited']);
  });
});
