import { HttpErrorResponse, provideHttpClient } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
  TestRequest,
} from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import {
  generateKeyPair,
  openRequest,
  peekEphemeral,
  relayAgentId,
  toBase64Url,
} from '@kubernanny/protocol';
import { beforeEach, describe, expect, it } from 'vitest';

import { pairingRoute } from '../app';
import { translatorFor } from '../i18n/translator';
import { ClusterConfig } from './agent.model';
import { AgentClient, describeError } from './agent-client.service';
import {
  PathMemory,
  relayCallUrl,
  REMEMBER_RELAY_MS,
  transportFailure,
  usableRelay,
} from './relay-route';

const json = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));

describe('relay route helpers', () => {
  it('uses a relay only when known, switched on and https (or local http)', () => {
    expect(usableRelay({})).toBeNull();
    expect(usableRelay({ relayUrl: 'https://relay.kubernanny.app/' })).toBe(
      'https://relay.kubernanny.app',
    );
    expect(usableRelay({ relayUrl: 'https://relay.kubernanny.app', relayOff: true })).toBeNull();
    expect(usableRelay({ relayUrl: 'http://relay.example.com' })).toBeNull();
    expect(usableRelay({ relayUrl: 'http://localhost:8090' })).toBe('http://localhost:8090');
    expect(usableRelay({ relayUrl: 'javascript:alert(1)' })).toBeNull();
  });

  it('addresses the agent by the hash of its pinned key', () => {
    const agent = generateKeyPair();
    expect(relayCallUrl('https://r.example', toBase64Url(agent.publicKey))).toBe(
      `https://r.example/v1/agents/${relayAgentId(agent.publicKey)}/e2e`,
    );
  });

  it('counts only unanswered calls as transport failures', () => {
    expect(transportFailure(new HttpErrorResponse({ status: 0 }))).toBe(true);
    expect(transportFailure(new HttpErrorResponse({ status: 504 }))).toBe(true);
    expect(transportFailure(new HttpErrorResponse({ status: 400 }))).toBe(false);
    expect(transportFailure(Object.assign(new Error('x'), { name: 'TimeoutError' }))).toBe(true);
  });

  it('remembers the relay for a while, then tries direct again', () => {
    const memory = new PathMemory();
    memory.set('k', 'relay', 0);
    expect(memory.get('k', REMEMBER_RELAY_MS - 1)).toBe('relay');
    expect(memory.get('k', REMEMBER_RELAY_MS)).toBeNull();
  });

  it('takes the relay from a pairing link only next to the key', () => {
    const key = 'A'.repeat(43);
    expect(
      pairingRoute(
        `kubernanny://pair?url=http%3A%2F%2F10.0.0.5&code=C&key=${key}&relay=https%3A%2F%2Frelay.kubernanny.app`,
      ),
    ).toMatchObject({ key, relay: 'https://relay.kubernanny.app' });
    expect(
      pairingRoute(
        'kubernanny://pair?url=http%3A%2F%2F10.0.0.5&code=C&relay=https%3A%2F%2Frelay.kubernanny.app',
      ),
    ).not.toHaveProperty('relay');
    expect(
      pairingRoute(
        `kubernanny://pair?url=http%3A%2F%2F10.0.0.5&code=C&key=${key}&relay=http%3A%2F%2Fevil.example`,
      ),
    ).not.toHaveProperty('relay');
  });

  it('explains relay refusals', () => {
    const err = new HttpErrorResponse({ status: 503, error: { code: 'RELAY_AGENT_OFFLINE' } });
    expect(describeError(err, translatorFor('de'))).toContain('Relay');
  });
});

describe('AgentClient direct first, relay as fallback', () => {
  const agent = generateKeyPair();
  const device = generateKeyPair();
  const relayUrl = 'https://relay.kubernanny.app';
  const cluster: ClusterConfig = {
    id: 'c1',
    name: 'home',
    url: 'http://10.0.0.5:8080',
    agentKey: toBase64Url(agent.publicKey),
    deviceKey: toBase64Url(device.secretKey),
    deviceId: 'd1',
    relayUrl,
  };
  const viaRelay = `${relayUrl}/v1/agents/${relayAgentId(agent.publicKey)}/e2e`;
  const direct = `${cluster.url}/api/e2e`;
  const probe = `${cluster.url}/healthz`;
  let client: AgentClient;
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    client = TestBed.inject(AgentClient);
    http = TestBed.inject(HttpTestingController);
  });

  /** The next request to `url`, waiting for the client's awaits in between. */
  async function next(url: string): Promise<TestRequest> {
    for (let i = 0; i < 50; i++) {
      const found = http.match(url);
      if (found.length) {
        return found[0]!;
      }
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    throw new Error(
      `no request to ${url}; open: ${http
        .match(() => true)
        .map((r) => r.request.url)
        .join(', ')}`,
    );
  }

  function unreachable(req: TestRequest) {
    req.error(new ProgressEvent('error'), { status: 0, statusText: 'Unknown Error' });
  }

  /** Plays the agent behind whichever path the request took. */
  function answer(req: TestRequest, body: unknown) {
    const opened = openRequest(agent, new Uint8Array(req.request.body as ArrayBuffer));
    req.flush(opened.respond(200, json(body), Date.now()).slice().buffer);
    return opened.request;
  }

  it('goes through the relay when the address does not answer, and stays there for a while', async () => {
    const pending = client.status(cluster);
    unreachable(await next(probe));
    const request = answer(await next(viaRelay), { light: 'green' });
    expect(request.path).toBe('/status');
    expect(await pending).toEqual({ light: 'green' });
    expect(client.paths()[cluster.agentKey]).toBe('relay');

    // Remembered: no probe, straight to the relay.
    const second = client.info(cluster);
    answer(await next(viaRelay), { cluster: 'home' });
    await second;
    http.expectNone(probe);
    http.verify();
  });

  it('stays direct when the address answers', async () => {
    const pending = client.status(cluster);
    (await next(probe)).flush('{"ok":true}');
    answer(await next(direct), { light: 'yellow' });
    expect(await pending).toEqual({ light: 'yellow' });
    expect(client.paths()[cluster.agentKey]).toBe('direct');
    http.expectNone(viaRelay);
  });

  it('retries a read through the relay, freshly sealed, when the direct call is lost', async () => {
    const pending = client.status(cluster);
    (await next(probe)).flush('{"ok":true}');
    const lost = await next(direct);
    const firstEphemeral = peekEphemeral(new Uint8Array(lost.request.body as ArrayBuffer));
    unreachable(lost);
    const retry = await next(viaRelay);
    expect(peekEphemeral(new Uint8Array(retry.request.body as ArrayBuffer))).not.toEqual(
      firstEphemeral,
    );
    answer(retry, { light: 'green' });
    expect(await pending).toEqual({ light: 'green' });
    expect(client.paths()[cluster.agentKey]).toBe('relay');
  });

  it('never sends an action twice: a lost direct POST fails instead of going to the relay', async () => {
    const pending = client
      .runAction(cluster, 'pods/default/Deployment/web', 'restart', 0)
      .catch((e: unknown) => e);
    (await next(probe)).flush('{"ok":true}');
    unreachable(await next(direct));
    expect(await pending).toBeInstanceOf(HttpErrorResponse);
    http.expectNone(viaRelay);
    expect(client.paths()[cluster.agentKey]).toBeUndefined();
  });

  it('does not probe or use the relay when it is switched off', async () => {
    const pending = client.status({ ...cluster, relayOff: true });
    answer(await next(direct), { light: 'green' });
    await pending;
    http.expectNone(probe);
    expect(client.paths()[cluster.agentKey]).toBeUndefined();
  });

  it('pairs through the relay with the key from the link', async () => {
    const pending = client.pair(cluster.url, cluster.agentKey, 'ABCDE23456', 'iPhone', relayUrl);
    unreachable(await next(probe));
    const request = answer(await next(viaRelay), { deviceId: 'd9', cluster: 'home' });
    expect(request).toMatchObject({
      method: 'POST',
      path: '/pair',
      body: { code: 'ABCDE23456', name: 'iPhone' },
    });
    expect(await pending).toMatchObject({ deviceId: 'd9', relayUrl, agentKey: cluster.agentKey });
  });
});
