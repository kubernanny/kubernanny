import { describe, expect, it } from 'vitest';

import { loadConfig } from '../config';
import { DemoKubeClient } from '../demo/demo-cluster';
import { KubeClient, KubeError } from '../kube/kube-client';
import { de } from '../testing/i18n';
import { SettingsService } from './settings.service';

const who = { kind: 'device' as const, id: 'd1', name: 'Test' };

async function service(env: Record<string, string>) {
  const saved = { ...process.env };
  Object.assign(process.env, env);
  const config = loadConfig();
  process.env = saved;
  const s = new SettingsService(config, new DemoKubeClient());
  await s.onModuleInit();
  return s;
}

describe('settings', () => {
  it('locks what the deployment switched off; the app cannot switch it on', async () => {
    const s = await service({ DISABLED_MODULES: 'argocd,notifications', DISABLED_ACTIONS: 'restart' });
    await s.onModuleInit();
    expect(s.moduleState('argocd')).toBe('locked');
    expect(s.actionState('restart')).toBe('locked');
    expect(s.notificationsOn()).toBe(false);
    await expect(s.update({ modules: { argocd: true } }, who)).rejects.toMatchObject({ status: 403 });
    await expect(s.update({ actions: { restart: true } }, who)).rejects.toMatchObject({ status: 403 });
    expect(s.view(['argocd']).modules.find((m) => m.id === 'argocd')?.state).toBe('locked');
  });

  it('keeps argocd-rollback locked until ENABLED_ACTIONS names it; DISABLED_ACTIONS wins; the demo shows it', async () => {
    expect((await service({})).actionState('argocd-rollback')).toBe('locked');
    await expect((await service({})).update({ actions: { 'argocd-rollback': true } }, who)).rejects.toMatchObject({
      status: 403,
    });
    const on = await service({ ENABLED_ACTIONS: 'argocd-rollback' });
    expect(on.actionState('argocd-rollback')).toBe('on');
    await on.update({ actions: { 'argocd-rollback': false } }, who);
    expect(on.actionState('argocd-rollback')).toBe('off');
    expect(
      (await service({ ENABLED_ACTIONS: 'argocd-rollback', DISABLED_ACTIONS: 'argocd-rollback' })).actionState(
        'argocd-rollback',
      ),
    ).toBe('locked');
    expect((await service({ DEMO: 'broken' })).actionState('argocd-rollback')).toBe('on');
    // The other action types are not opt-in.
    expect((await service({})).actionState('argocd-sync')).toBe('on');
  });

  it('keeps app switches across a restart through the ConfigMap', async () => {
    const kube = new DemoKubeClient();
    const config = loadConfig();
    const first = new SettingsService(config, kube);
    await first.onModuleInit();
    await first.update({ modules: { longhorn: false }, actions: { logs: false }, notifications: false }, who);
    const second = new SettingsService(config, kube);
    await second.onModuleInit();
    expect(second.moduleState('longhorn')).toBe('off');
    expect(second.actionOn('logs')).toBe(false);
    expect(second.notificationsOn()).toBe(false);
  });

  it('tells listeners about every change', async () => {
    const s = await service({});
    await s.onModuleInit();
    let calls = 0;
    s.onChange(() => calls++);
    await s.update({ notifications: true }, who);
    expect(calls).toBe(1);
  });
});

/** A cluster that is not the demo: only the settings ConfigMap. */
class ConfigMapKube extends KubeClient {
  data: Record<string, string> | null = null;
  override async get<T>(): Promise<T> {
    if (!this.data) {
      throw new KubeError(404, 'not found');
    }
    return { data: this.data } as T;
  }
  override async mergePatch(_path: string, body: unknown): Promise<void> {
    if (!this.data) {
      throw new KubeError(404, 'not found');
    }
    this.data = { ...this.data, ...(body as { data: Record<string, string> }).data };
  }
  override async create(_path: string, body: unknown): Promise<void> {
    this.data = { ...(body as { data: Record<string, string> }).data };
  }
}

function withEnv(env: Record<string, string>, kube: KubeClient) {
  const saved = { ...process.env };
  Object.assign(process.env, env);
  const config = loadConfig();
  process.env = saved;
  return new SettingsService(config, kube);
}

describe('modules that are off by default', () => {
  it('keeps vulnerabilities off until switched on, and says what it would send', async () => {
    const s = withEnv({}, new ConfigMapKube());
    await s.onModuleInit();
    expect(s.moduleState('vulnerabilities')).toBe('off');
    expect(s.moduleOn('security')).toBe(true);
    const row = de(s.view([])).modules.find((m) => m.id === 'vulnerabilities')!;
    expect(row).toMatchObject({
      state: 'off',
      defaultOff: true,
      privacy:
        'Schickt Namen und Versionen der Komponenten an api.osv.dev (Google). Keine Clusterdaten, keine Namen von Workloads.',
    });
    expect(s.view([]).modules.find((m) => m.id === 'security')).not.toHaveProperty('privacy');
  });

  it('remembers the app switching it on and off across restarts', async () => {
    const kube = new ConfigMapKube();
    const first = withEnv({}, kube);
    await first.onModuleInit();
    await first.update({ modules: { vulnerabilities: true } }, who);
    const second = withEnv({}, kube);
    await second.onModuleInit();
    expect(second.moduleState('vulnerabilities')).toBe('on');
    await second.update({ modules: { vulnerabilities: false } }, who);
    expect(second.moduleState('vulnerabilities')).toBe('off');
  });

  it('is on for an install that enables it, and the app can still switch it off', async () => {
    const kube = new ConfigMapKube();
    const s = withEnv({ ENABLED_MODULES: 'vulnerabilities' }, kube);
    await s.onModuleInit();
    expect(s.moduleState('vulnerabilities')).toBe('on');
    await s.update({ modules: { vulnerabilities: false } }, who);
    const after = withEnv({ ENABLED_MODULES: 'vulnerabilities' }, kube);
    await after.onModuleInit();
    expect(after.moduleState('vulnerabilities')).toBe('off');
  });

  it('stays locked when the deployment switched it off, whatever else says on', async () => {
    const s = withEnv({ ENABLED_MODULES: 'vulnerabilities', DISABLED_MODULES: 'vulnerabilities' }, new ConfigMapKube());
    await s.onModuleInit();
    expect(s.moduleState('vulnerabilities')).toBe('locked');
    await expect(s.update({ modules: { vulnerabilities: true } }, who)).rejects.toMatchObject({ status: 403 });
  });

  it('is on in the demo, which never calls the internet', async () => {
    const s = withEnv({}, new DemoKubeClient());
    await s.onModuleInit();
    expect(s.moduleState('vulnerabilities')).toBe('on');
  });

  it('accepts only https or in-cluster http for a self-hosted database', () => {
    expect(() => withEnv({ VULN_DB_URL: 'http://osv.example.org' }, new ConfigMapKube())).toThrow(
      'VULN_DB_URL must use https',
    );
    expect(
      de(withEnv({ VULN_DB_URL: 'http://osv-mirror.osv.svc:8080/' }, new ConfigMapKube()).view([])).modules.find(
        (m) => m.id === 'vulnerabilities',
      )?.privacy,
    ).toContain('an osv-mirror.osv.svc:8080.');
  });
});
