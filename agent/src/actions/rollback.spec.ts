import { HttpError } from '../http/errors';
import { describe, expect, it, vi } from 'vitest';
import type { ArgoApplication } from '../checks/argocd.check';
import { rollbackApps, rollbackTarget } from '../checks/argocd-rollback';
import { KubeClient, KubeError } from '../kube/kube-client';
import type { Notifier } from '../notify/notifier';
import type { SettingsService } from '../settings/settings.service';
import type { StatusService } from '../status/status.service';
import { ROLLBACK_INTERVAL_MS, RollbackService } from './rollback.service';

const SHA = (c: string) => c.repeat(40);
const SOURCE = { repoURL: 'https://git.example/shop.git', path: 'deploy', targetRevision: 'main' };

function argoApp(over: Partial<ArgoApplication> = {}, status: ArgoApplication['status'] = {}): ArgoApplication {
  return {
    metadata: { name: 'shop', namespace: 'argocd' },
    spec: { destination: { namespace: 'shop' }, source: SOURCE, ...over.spec },
    status: {
      sync: { status: 'Synced', revision: SHA('c') },
      history: [
        { id: 1, revision: SHA('a'), deployedAt: '2026-11-01T10:00:00Z', source: SOURCE },
        { id: 2, revision: SHA('b'), deployedAt: '2026-11-10T10:00:00Z', source: { ...SOURCE, targetRevision: 'v2' } },
        { id: 3, revision: SHA('c'), deployedAt: '2026-11-20T10:00:00Z', source: SOURCE },
      ],
      ...status,
    },
    ...(over.operation !== undefined ? { operation: over.operation } : {}),
  };
}

describe('rollbackTarget (what the route accepts)', () => {
  it('takes an earlier entry of the same source with a commit SHA', () => {
    expect(rollbackTarget(argoApp(), 1)).toMatchObject({ revision: SHA('a') });
    // The target revision of the entry may differ: only repo and path must match.
    expect(rollbackTarget(argoApp(), 2)).toMatchObject({ revision: SHA('b') });
  });

  it.each([
    ['ROLLBACK_AUTOMATED', argoApp({ spec: { syncPolicy: { automated: {} } } }), 1],
    ['ROLLBACK_MULTI_SOURCE', argoApp({ spec: { sources: [SOURCE] } }), 1],
    ['ROLLBACK_NO_SOURCE', argoApp({ spec: { source: undefined } }), 1],
    ['ROLLBACK_RUNNING', argoApp({ operation: { sync: {} } }), 1],
    ['ROLLBACK_RUNNING', argoApp({}, { operationState: { phase: 'Running' } }), 1],
    ['ROLLBACK_HISTORY_NOT_FOUND', argoApp(), 42],
    ['ROLLBACK_CURRENT', argoApp(), 3],
    ['ROLLBACK_REVISION', argoApp({}, { history: [{ id: 1, revision: 'main', source: SOURCE }] }), 1],
    ['ROLLBACK_REVISION', argoApp({}, { history: [{ id: 1, revision: `${SHA('a')}\nx`, source: SOURCE }] }), 1],
    ['ROLLBACK_OTHER_SOURCE', argoApp({}, { history: [{ id: 1, revision: SHA('a'), source: { ...SOURCE, repoURL: 'https://evil.example/x.git' } }] }), 1],
    ['ROLLBACK_OTHER_SOURCE', argoApp({}, { history: [{ id: 1, revision: SHA('a'), source: { ...SOURCE, path: 'other' } }] }), 1],
    ['ROLLBACK_OTHER_SOURCE', argoApp({}, { history: [{ id: 1, revision: SHA('a') }] }), 1],
  ] as const)('refuses with %s', (code, app, id) => {
    expect(rollbackTarget(app, id)).toEqual({ refusal: code });
  });

  it('accepts a chart version for a Helm chart source, and nothing looser', () => {
    const chart = { repoURL: 'https://charts.example', chart: 'shop', targetRevision: '1.4.0' };
    const app = argoApp({ spec: { source: chart } }, { sync: { revision: '1.4.0' }, history: [
      { id: 1, revision: '1.3.2', source: chart },
      { id: 2, revision: 'latest', source: chart },
      { id: 3, revision: '1.4.0', source: chart },
    ] });
    expect(rollbackTarget(app, 1)).toMatchObject({ revision: '1.3.2' });
    expect(rollbackTarget(app, 2)).toEqual({ refusal: 'ROLLBACK_REVISION' });
  });
});

describe('rollbackApps (what the sheet lists)', () => {
  it('lists manual-sync single-source apps with their entries newest first, the current one marked', () => {
    const apps = rollbackApps([argoApp(), argoApp({ spec: { syncPolicy: { automated: {} } } }), argoApp({ spec: { sources: [SOURCE] } })]);
    expect(apps).toHaveLength(1);
    expect(apps[0]).toEqual({
      namespace: 'argocd',
      app: 'shop',
      current: 'ccccccc',
      entries: [
        { id: 3, revision: SHA('c'), short: 'ccccccc', deployedAt: '2026-11-20T10:00:00Z', current: true },
        { id: 2, revision: SHA('b'), short: 'bbbbbbb', deployedAt: '2026-11-10T10:00:00Z', current: false },
        { id: 1, revision: SHA('a'), short: 'aaaaaaa', deployedAt: '2026-11-01T10:00:00Z', current: false },
      ],
    });
  });

  it('leaves out entries of another source and apps with nothing to go back to', () => {
    const foreign = argoApp({}, { history: [{ id: 1, revision: SHA('a'), source: { repoURL: 'https://evil.example' } }, { id: 3, revision: SHA('c'), source: SOURCE }] });
    expect(rollbackApps([foreign])).toEqual([]);
  });
});

function service(opts: { on?: boolean; argocd?: boolean; app?: ArgoApplication | 'missing' } = {}) {
  const order: string[] = [];
  const kube = {
    get: vi.fn(async () => {
      if (opts.app === 'missing') {
        throw new KubeError(404, 'not found');
      }
      return opts.app ?? argoApp();
    }),
    mergePatch: vi.fn(async () => {
      order.push('patch');
    }),
  };
  const settings = { actionOn: vi.fn(() => opts.on ?? true), moduleOn: vi.fn(() => opts.argocd ?? true) };
  const notifier = {
    securityAlert: vi.fn(async () => {
      order.push('alert');
    }),
  };
  const status = { refresh: vi.fn(async () => undefined) };
  const svc = new RollbackService(kube as unknown as KubeClient, settings as unknown as SettingsService, status as unknown as StatusService, notifier as unknown as Notifier);
  return { svc, kube, notifier, order };
}

const who = { kind: 'device' as const, id: 'd1', name: 'Phone' };
const code = async (p: Promise<unknown>) => {
  try {
    await p;
    return 'none';
  } catch (err) {
    return ((err as HttpError).getResponse() as { code: string }).code;
  }
};

describe('RollbackService', () => {
  it('announces first, then sends exactly the rollback patch', async () => {
    const { svc, kube, notifier, order } = service();
    const result = await svc.rollback({ namespace: 'argocd', app: 'shop', id: 1 }, who, 1_000_000);
    expect(result.revision).toBe(SHA('a'));
    expect(order).toEqual(['alert', 'patch']);
    expect(notifier.securityAlert).toHaveBeenCalledWith('Phone', [{ kind: 'rolledBack', app: 'argocd/shop', from: 'ccccccc', to: 'aaaaaaa' }]);
    expect(kube.mergePatch).toHaveBeenCalledWith('/apis/argoproj.io/v1alpha1/namespaces/argocd/applications/shop', {
      operation: {
        initiatedBy: { username: 'kubernanny' },
        info: [{ name: 'Reason', value: 'Rollback from the Kubernanny app' }],
        sync: { revision: SHA('a'), syncStrategy: { hook: {} } },
      },
    });
  });

  it('refuses before reading anything when the action is off or Argo CD is not checked', async () => {
    for (const opts of [{ on: false }, { argocd: false }]) {
      const { svc, kube } = service(opts);
      expect(await code(svc.rollback({ namespace: 'argocd', app: 'shop', id: 1 }, who))).toBe(opts.on === false ? 'ACTION_DISABLED' : 'MODULE_OFF');
      expect(kube.get).not.toHaveBeenCalled();
    }
  });

  it('refuses malformed targets, unknown apps and every reason of rollbackTarget without patching', async () => {
    for (const body of [{}, { namespace: 'argocd', app: 'shop' }, { namespace: 'argocd', app: 'shop', id: '1' }, { namespace: 'Argo CD', app: 'shop', id: 1 }, { namespace: 'argocd', app: 'shop', id: 1.5 }]) {
      const { svc, kube } = service();
      expect(await code(svc.rollback(body, who))).toBe('ROLLBACK_TARGET');
      expect(kube.get).not.toHaveBeenCalled();
    }
    const missing = service({ app: 'missing' });
    expect(await code(missing.svc.rollback({ namespace: 'argocd', app: 'shop', id: 1 }, who))).toBe('APP_NOT_FOUND');
    const automated = service({ app: argoApp({ spec: { syncPolicy: { automated: {} } } }) });
    expect(await code(automated.svc.rollback({ namespace: 'argocd', app: 'shop', id: 1 }, who))).toBe('ROLLBACK_AUTOMATED');
    const current = service();
    expect(await code(current.svc.rollback({ namespace: 'argocd', app: 'shop', id: 3 }, who))).toBe('ROLLBACK_CURRENT');
    for (const s of [missing, automated, current]) {
      expect(s.kube.mergePatch).not.toHaveBeenCalled();
      expect(s.notifier.securityAlert).not.toHaveBeenCalled();
    }
  });

  it('rolls one app back at most once in 5 minutes', async () => {
    const { svc, kube } = service();
    await svc.rollback({ namespace: 'argocd', app: 'shop', id: 1 }, who, 0);
    expect(await code(svc.rollback({ namespace: 'argocd', app: 'shop', id: 2 }, who, ROLLBACK_INTERVAL_MS - 1))).toBe('ROLLBACK_RATE_LIMITED');
    // Another app is not held back.
    await svc.rollback({ namespace: 'argocd', app: 'web', id: 1 }, who, 1);
    await svc.rollback({ namespace: 'argocd', app: 'shop', id: 2 }, who, ROLLBACK_INTERVAL_MS);
    expect(kube.mergePatch).toHaveBeenCalledTimes(3);
  });
});
