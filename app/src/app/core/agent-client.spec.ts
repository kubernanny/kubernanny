import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { generateKeyPair, openRequest, toBase64Url } from '@kubernanny/protocol';
import { beforeEach, describe, expect, it } from 'vitest';

import { translatorFor } from '../i18n/translator';
import { ClusterConfig } from './agent.model';
import { AgentClient, AgentError, describeError } from './agent-client.service';

const json = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));

describe('AgentClient end to end', () => {
  const agent = generateKeyPair();
  const device = generateKeyPair();
  const cluster: ClusterConfig = {
    id: 'c1',
    name: 'home',
    url: 'http://10.0.0.5:8080',
    agentKey: toBase64Url(agent.publicKey),
    deviceKey: toBase64Url(device.secretKey),
    deviceId: 'd1',
  };
  let client: AgentClient;
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    client = TestBed.inject(AgentClient);
    http = TestBed.inject(HttpTestingController);
  });

  /** Plays the agent for the next request: decrypts, checks, answers. */
  async function answer(status: number, body: unknown, agentTime = Date.now()) {
    await Promise.resolve();
    const req = http.expectOne(`${cluster.url}/api/e2e`);
    expect(req.request.method).toBe('POST');
    expect(req.request.headers.get('authorization')).toBeNull();
    const opened = openRequest(agent, new Uint8Array(req.request.body as ArrayBuffer));
    expect(opened.devicePublicKey).toEqual(device.publicKey);
    req.flush(opened.respond(status, json(body), agentTime).slice().buffer);
    return opened.request;
  }

  it('sends the request sealed and reads the sealed answer, over plain http too', async () => {
    const pending = client.history(cluster, 24);
    const request = await answer(200, { source: 'agent', series: [] });
    expect(request).toMatchObject({ method: 'GET', path: '/history?hours=24' });
    expect(await pending).toEqual({ source: 'agent', series: [] });
  });

  it('puts query parameters with slashes into the path, encoded', async () => {
    const pending = client.runAction(cluster, 'pods/default/Deployment/x', 'restart', 0);
    const request = await answer(200, { done: 'ok' });
    expect(request.path).toBe('/actions/restart?issue=pods%2Fdefault%2FDeployment%2Fx&index=0');
    await pending;
  });

  it('corrects its clock from the agent and retries once', async () => {
    const pending = client.status(cluster);
    const agentTime = Date.now() + 3_600_000;
    await answer(401, { code: 'E2E_CLOCK_SKEW' }, agentTime);
    const retry = await answer(200, { light: 'green' });
    expect(Math.abs(retry.time - agentTime)).toBeLessThan(5000);
    expect(await pending).toEqual({ light: 'green' });
  });

  it('turns an authenticated error into AgentError with its code', async () => {
    const pending = client.status(cluster);
    await answer(401, { code: 'DEVICE_UNKNOWN', message: 'x' });
    const err = await pending.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AgentError);
    expect(describeError(err, translatorFor('de'))).toContain('nicht (mehr) gekoppelt');
  });

  it('rejects an answer from anyone but the pinned agent', async () => {
    const pending = client.status(cluster);
    await Promise.resolve();
    const req = http.expectOne(`${cluster.url}/api/e2e`);
    // An impostor sees the request but cannot open it; a made-up answer does not verify.
    expect(() =>
      openRequest(generateKeyPair(), new Uint8Array(req.request.body as ArrayBuffer)),
    ).toThrow();
    req.flush(new Uint8Array([1, 0, 40, ...new Uint8Array(40)]).buffer);
    const err = await pending.catch((e: unknown) => e);
    expect(describeError(err, translatorFor('de'))).toContain('nicht vom gekoppelten Agent');
  });

  it('pairs with a fresh key pair and the code, and never sends a private key', async () => {
    const pending = client.pair(cluster.url, cluster.agentKey, 'ABCDE23456', 'iPhone, Safari');
    await Promise.resolve();
    const req = http.expectOne(`${cluster.url}/api/e2e`);
    const opened = openRequest(agent, new Uint8Array(req.request.body as ArrayBuffer));
    expect(opened.request).toMatchObject({
      method: 'POST',
      path: '/pair',
      body: { code: 'ABCDE23456', name: 'iPhone, Safari' },
    });
    req.flush(
      opened.respond(200, json({ deviceId: 'd9', cluster: 'home' }), Date.now()).slice().buffer,
    );
    const pairing = await pending;
    expect(pairing).toMatchObject({
      url: cluster.url,
      agentKey: cluster.agentKey,
      deviceId: 'd9',
      cluster: 'home',
    });
    expect(pairing.deviceKey).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(new TextDecoder().decode(new Uint8Array(req.request.body as ArrayBuffer))).not.toContain(
      pairing.deviceKey,
    );
  });

  it('refuses to fetch an unpinned key over plain http', async () => {
    await expect(client.identity('http://10.0.0.5:8080')).rejects.toThrow(/plain http/);
  });
});
