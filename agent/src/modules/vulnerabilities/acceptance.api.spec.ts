import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { Agent } from '../../agent';
import { IdentityService } from '../../auth/identity.service';
import { DemoKubeClient } from '../../demo/demo-cluster';
import { PairingService } from '../../pairing/pairing';
import { StatusService } from '../../status/status.service';
import { E2eClient } from '../../testing/e2e-client';

interface VulnIssue {
  id: string;
  advisories?: string[];
}

/** The real routes over the end-to-end channel, against the demo cluster and its canned advisories. */
async function start(
  env: Record<string, string> = {},
): Promise<{ app: Agent; phone: E2eClient; kube: DemoKubeClient }> {
  delete process.env.DEMO;
  process.env.LANGUAGE = 'en';
  process.env.CHECK_INTERVAL_SECONDS = '3600';
  process.env.POD_NAMESPACE = 'kubernanny';
  process.env.INTERNAL_SOCKET = join(mkdtempSync(join(tmpdir(), 'kubernanny-')), 'agent.sock');
  delete process.env.VULN_ACCEPT;
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

describe('POST /api/vulnerabilities/accept', () => {
  let app: Agent | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
    for (const key of ['INTERNAL_SOCKET', 'LANGUAGE', 'VULN_ACCEPT']) {
      delete process.env[key];
    }
  });

  it('takes an advisory out of its issue, lists it on the module sheet, and takes it back', async () => {
    const started = await start();
    app = started.app;
    const { phone } = started;
    const before = (await phone.get('/status', 200)).body;
    const issue = (before.issues as VulnIssue[]).find(
      (i) => i.id.startsWith('vulnerabilities/') && (i.advisories?.length ?? 0) > 0,
    )!;
    expect(issue).toBeDefined();
    const component = issue.id.slice('vulnerabilities/'.length);
    const advisory = issue.advisories![0]!;

    const { body } = await phone.post(
      '/vulnerabilities/accept',
      { component, advisory, days: 30, reason: 'not exposed' },
      200,
    );
    expect(Date.parse(body.acceptedUntil)).toBeGreaterThan(Date.now() + 29 * 86_400_000);

    const after = (await phone.get('/status', 200)).body;
    const still = (after.issues as VulnIssue[]).find((i) => i.id === issue.id);
    expect(still?.advisories ?? []).not.toContain(advisory);
    const sheet = after.modules.find((m: { id: string }) => m.id === 'vulnerabilities');
    expect(sheet.canAccept).toBe(true);
    expect(sheet.accepted).toEqual([
      expect.objectContaining({ component, advisory, by: 'Testhandy', reason: 'not exposed' }),
    ]);

    await phone.post('/vulnerabilities/unaccept', { component, advisory }, 204);
    const back = (await phone.get('/status', 200)).body;
    expect((back.issues as VulnIssue[]).find((i) => i.id === issue.id)?.advisories).toContain(advisory);
  });

  it('accepts a Trivy Operator finding on its workload, also with the built-in lookup locked off', async () => {
    const started = await start({ DISABLED_MODULES: 'vulnerabilities' });
    app = started.app;
    const { phone } = started;
    const issue = ((await phone.get('/status', 200)).body.issues as VulnIssue[]).find(
      (i) => i.id === 'trivy/default/Deployment/social-importer',
    )!;
    expect(issue.advisories).toEqual(['CVE-2024-21538']);
    const component = 'trivy:default:deployment:social-importer';
    // The workload key, not the issue id, and only for the workload that reports it.
    expect(
      (
        await phone.post('/vulnerabilities/accept', {
          component: 'trivy:default:statefulset:shop-api-valkey',
          advisory: 'CVE-2024-21538',
          days: 30,
        })
      ).status,
    ).toBe(404);
    await phone.post('/vulnerabilities/accept', { component, advisory: 'CVE-2024-21538', days: 90 }, 200);

    const after = (await phone.get('/status', 200)).body;
    expect((after.issues as VulnIssue[]).find((i) => i.id === issue.id)).toBeUndefined();
    const sheet = after.modules.find((m: { id: string }) => m.id === 'trivy');
    expect(sheet.canAccept).toBe(true);
    expect(sheet.accepted).toEqual([
      expect.objectContaining({ component, advisory: 'CVE-2024-21538', name: 'social-importer' }),
    ]);
    await phone.post('/vulnerabilities/unaccept', { component, advisory: 'CVE-2024-21538' }, 204);
    expect(((await phone.get('/status', 200)).body.issues as VulnIssue[]).some((i) => i.id === issue.id)).toBe(true);
    delete process.env.DISABLED_MODULES;
  });

  it('refuses advisories the agent does not report, other durations and a missing body', async () => {
    const started = await start();
    app = started.app;
    const { phone } = started;
    expect(
      (await phone.post('/vulnerabilities/accept', { component: 'cnpg', advisory: 'GHSA-none-none-none', days: 30 }))
        .status,
    ).toBe(404);
    const issue = ((await phone.get('/status', 200)).body.issues as VulnIssue[]).find(
      (i) => i.id.startsWith('vulnerabilities/') && i.advisories?.length,
    )!;
    const component = issue.id.slice('vulnerabilities/'.length);
    expect(
      (await phone.post('/vulnerabilities/accept', { component, advisory: issue.advisories![0], days: 1000 })).status,
    ).toBe(400);
    expect((await phone.post('/vulnerabilities/accept', { advisory: 'x' })).status).toBe(400);
  });

  it('is refused with vulnerabilities.allowAccept: false, before anything is written', async () => {
    const started = await start({ VULN_ACCEPT: 'off' });
    app = started.app;
    const { phone, kube } = started;
    const issue = ((await phone.get('/status', 200)).body.issues as VulnIssue[]).find(
      (i) => i.id.startsWith('vulnerabilities/') && i.advisories?.length,
    )!;
    const writes = kube.writes.length;
    const res = await phone.post('/vulnerabilities/accept', {
      component: issue.id.slice('vulnerabilities/'.length),
      advisory: issue.advisories![0],
      days: 30,
    });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('ACCEPT_LOCKED');
    expect((await phone.post('/vulnerabilities/unaccept', { component: 'cnpg', advisory: 'GHSA-1' })).status).toBe(403);
    expect(kube.writes.length).toBe(writes);
    const sheet = (await phone.get('/status', 200)).body.modules.find(
      (m: { id: string }) => m.id === 'vulnerabilities',
    );
    expect(sheet.canAccept).toBe(false);
  });

  it('is refused when the built-in lookup and the Trivy integration are switched off in Helm', async () => {
    const started = await start({ DISABLED_MODULES: 'vulnerabilities,trivy' });
    app = started.app;
    const res = await started.phone.post('/vulnerabilities/accept', {
      component: 'cnpg',
      advisory: 'GHSA-1',
      days: 30,
    });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('MODULE_OFF');
    delete process.env.DISABLED_MODULES;
  });
});
