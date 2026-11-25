import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Agent } from '../agent';
import { IdentityService } from '../auth/identity.service';
import { DemoKubeClient, ROLLBACK_APP } from '../demo/demo-cluster';
import { PairingService } from '../pairing/pairing';
import { StatusService } from '../status/status.service';
import { E2eClient } from '../testing/e2e-client';

const ENV = ['INTERNAL_SOCKET', 'LANGUAGE', 'ENABLED_ACTIONS', 'DISABLED_ACTIONS', 'CHECK_INTERVAL_SECONDS', 'POD_NAMESPACE'];

/** The real route over the end-to-end channel, against the demo cluster (DEMO itself off, so the opt-in decides). */
async function start(env: Record<string, string> = {}): Promise<{ app: Agent; phone: E2eClient; kube: DemoKubeClient }> {
  delete process.env.DEMO;
  process.env.LANGUAGE = 'en';
  process.env.CHECK_INTERVAL_SECONDS = '3600';
  process.env.POD_NAMESPACE = 'kubernanny';
  process.env.INTERNAL_SOCKET = join(mkdtempSync(join(tmpdir(), 'kubernanny-')), 'agent.sock');
  Object.assign(process.env, env);
  const kube = new DemoKubeClient();
  const moduleRef = new Agent({ kube: kube });
  const app = moduleRef;
  await app.init();
  await app.get(StatusService).refresh();
  const phone = new E2eClient(app.getHttpServer(), app.get(IdentityService).publicKey);
  await phone.post('/pair', { code: app.get(PairingService).issue(), name: 'Testhandy' }, 200);
  return { app, phone, kube };
}

const argoWrites = (kube: DemoKubeClient) => kube.writes.filter((w) => w.path.includes('argoproj.io'));

describe('POST /api/argocd/rollback', () => {
  let app: Agent | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
    for (const key of ENV) {
      delete process.env[key];
    }
  });

  it('is off by default: refused before reading, locked in the settings, no history on the sheet', async () => {
    const started = await start();
    app = started.app;
    const { phone, kube } = started;
    const reads = kube.lists.length;
    const refused = await phone.post('/argocd/rollback', { namespace: 'argocd', app: ROLLBACK_APP, id: 7 }, 403);
    expect(refused.body.code).toBe('ACTION_DISABLED');
    expect(kube.lists.length).toBe(reads);
    expect(argoWrites(kube)).toEqual([]);
    const settings = (await phone.get('/settings', 200)).body;
    expect(settings.actions.find((a: { type: string }) => a.type === 'argocd-rollback').state).toBe('locked');
    const argocd = (await phone.get('/status', 200)).body.modules.find((m: { id: string }) => m.id === 'argocd');
    expect(argocd.rollbacks).toBeUndefined();
  });

  it('with ENABLED_ACTIONS lists the history and rolls a manual-sync app back, once in 5 minutes', async () => {
    const started = await start({ ENABLED_ACTIONS: 'argocd-rollback' });
    app = started.app;
    const { phone, kube } = started;
    const argocd = (await phone.get('/status', 200)).body.modules.find((m: { id: string }) => m.id === 'argocd');
    expect(argocd.rollbacks).toEqual([
      expect.objectContaining({ namespace: 'argocd', app: ROLLBACK_APP, current: 'c4d5e6f', entries: [expect.objectContaining({ id: 9, current: true }), expect.objectContaining({ id: 8, short: 'a71e0c9', current: false }), expect.objectContaining({ id: 7, current: false })] }),
    ]);
    const settings = (await phone.get('/settings', 200)).body;
    expect(settings.actions.find((a: { type: string }) => a.type === 'argocd-rollback').state).toBe('on');

    const { body } = await phone.post('/argocd/rollback', { namespace: 'argocd', app: ROLLBACK_APP, id: 7 }, 200);
    expect(body).toEqual({ done: `Rolling ${ROLLBACK_APP} back to 3f9c2a1.`, revision: '3f9c2a1d8e7b6a5c4d3e2f1a0b9c8d7e6f5a4b3c' });
    expect(argoWrites(kube)).toEqual([
      {
        method: 'PATCH',
        path: `/apis/argoproj.io/v1alpha1/namespaces/argocd/applications/${ROLLBACK_APP}`,
        body: { operation: { initiatedBy: { username: 'kubernanny' }, info: [{ name: 'Reason', value: 'Rollback from the Kubernanny app' }], sync: { revision: '3f9c2a1d8e7b6a5c4d3e2f1a0b9c8d7e6f5a4b3c', syncStrategy: { hook: {} } } } },
      },
    ]);
    expect((await phone.post('/argocd/rollback', { namespace: 'argocd', app: ROLLBACK_APP, id: 8 }, 429)).body.code).toBe('ROLLBACK_RATE_LIMITED');
    expect(argoWrites(kube)).toHaveLength(1);
  });

  it('refuses what the agent does not see as a rollback target', async () => {
    const started = await start({ ENABLED_ACTIONS: 'argocd-rollback' });
    app = started.app;
    const { phone, kube } = started;
    const cases: [unknown, number, string][] = [
      [{ namespace: 'argocd', app: 'shop-api-chart', id: 1 }, 409, 'ROLLBACK_AUTOMATED'],
      [{ namespace: 'argocd', app: 'weblate-chart', id: 1 }, 409, 'ROLLBACK_NO_SOURCE'],
      [{ namespace: 'argocd', app: ROLLBACK_APP, id: 1 }, 409, 'ROLLBACK_HISTORY_NOT_FOUND'],
      [{ namespace: 'argocd', app: ROLLBACK_APP, id: 9 }, 409, 'ROLLBACK_CURRENT'],
      [{ namespace: 'argocd', app: 'nope', id: 7 }, 404, 'APP_NOT_FOUND'],
      [{ namespace: 'argocd', app: ROLLBACK_APP, id: 'HEAD' }, 400, 'ROLLBACK_TARGET'],
      [{ namespace: 'argocd', app: ROLLBACK_APP, id: 7, revision: 'evil' }, 200, ''],
    ];
    for (const [body, status, code] of cases) {
      const res = await phone.post('/argocd/rollback', body, status);
      if (code) {
        expect(res.body.code, JSON.stringify(body)).toBe(code);
      }
    }
    // The extra `revision` of the last request was ignored: the history's revision went out.
    expect(argoWrites(kube).map((w) => JSON.stringify(w.body))).toEqual([expect.stringContaining('3f9c2a1d8e7b6a5c4d3e2f1a0b9c8d7e6f5a4b3c')]);
  });

  it('lets DISABLED_ACTIONS win over ENABLED_ACTIONS', async () => {
    const started = await start({ ENABLED_ACTIONS: 'argocd-rollback', DISABLED_ACTIONS: 'argocd-rollback' });
    app = started.app;
    expect((await started.phone.post('/argocd/rollback', { namespace: 'argocd', app: ROLLBACK_APP, id: 7 }, 403)).body.code).toBe('ACTION_DISABLED');
  });

  it('can be switched off in the app once enabled', async () => {
    const started = await start({ ENABLED_ACTIONS: 'argocd-rollback' });
    app = started.app;
    await started.phone.post('/settings', { actions: { 'argocd-rollback': false } }, 200);
    expect((await started.phone.post('/argocd/rollback', { namespace: 'argocd', app: ROLLBACK_APP, id: 7 }, 403)).body.code).toBe('ACTION_DISABLED');
  });

  it('stops the start for an id that cannot be enabled', async () => {
    await expect(start({ ENABLED_ACTIONS: 'restart' })).rejects.toThrow(/cannot be enabled: restart/);
    await expect(start({ ENABLED_ACTIONS: 'argocd-rolback' })).rejects.toThrow(/cannot be enabled/);
  });
});
