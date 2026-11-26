import { afterEach, describe, expect, it } from 'vitest';

import { Agent } from '../agent';
import { DemoKubeClient, DemoScenario } from '../demo/demo-cluster';
import { KubeError } from '../kube/kube-client';
import { Notifier } from '../notify/notifier';
import { Snapshot } from '../status/status.service';
import { en } from '../testing/i18n';
import { gatherInventory } from './inventory';

/** The demo cluster, with lists that can fail the way a busy API server fails them (timeouts, 429, 500, 403). */
class SlowKube extends DemoKubeClient {
  failing = new Set<string>();
  status = 500;
  override async list<T>(path: string): Promise<T[] | null> {
    if ([...this.failing].some((p) => path.startsWith(p))) {
      throw new KubeError(
        this.status,
        `${this.status} on ${path}: the server is currently unable to handle the request`,
      );
    }
    return super.list<T>(path);
  }
}

const WORKLOAD_LISTS = [
  '/apis/apps/v1/deployments',
  '/apis/apps/v1/statefulsets',
  '/apis/apps/v1/daemonsets',
  '/apis/batch/v1/jobs',
  '/api/v1/services',
  '/api/v1/persistentvolumeclaims',
  '/apis/networking.k8s.io/v1/ingresses',
];

describe('a list that fails (review: optional() made it look empty)', () => {
  let agent: Agent | null = null;
  afterEach(async () => {
    await agent?.close();
    agent = null;
  });

  async function start(scenario: DemoScenario) {
    process.env.CHECK_INTERVAL_SECONDS = '3600';
    const kube = new SlowKube(undefined, scenario);
    const pushed: Snapshot[] = [];
    const notifier = {
      channels: ['ntfy'],
      update: async (s: Snapshot) => void pushed.push(s),
      securityAlert: async () => undefined,
      test: async () => [],
    };
    agent = new Agent({ kube, notifier: notifier as unknown as Notifier });
    await agent.status.refresh();
    return { kube, status: agent.status, pushed };
  }

  it('keeps the last known objects and their issues, so nothing is "resolved" by a failed read', async () => {
    const { kube, status, pushed } = await start('broken');
    const before = status.snapshot();
    const components = status.state().detected.map((d) => d.entry.id);
    expect(before.issues.length).toBeGreaterThan(3);

    kube.failing = new Set(WORKLOAD_LISTS);
    await status.refresh();
    const after = status.snapshot();
    // Same issues, same first-seen times: the notifier sees nothing open or close.
    expect(after.issues.map((i) => [i.id, i.since])).toEqual(before.issues.map((i) => [i.id, i.since]));
    expect(status.state().detected.map((d) => d.entry.id)).toEqual(components);
    expect(status.state().inv.stale.sort()).toEqual([
      'daemonsets',
      'deployments',
      'ingresses',
      'jobs',
      'pvcs',
      'services',
      'statefulsets',
    ]);
    expect(pushed.at(-1)!.issues.map((i) => i.id)).toEqual(before.issues.map((i) => i.id));
  });

  it('reports the modules that read a failed list as error, so a healthy cluster does not stay green on old data', async () => {
    const { kube, status } = await start('healthy');
    expect(status.snapshot().light).toBe('green');

    kube.failing = new Set(['/apis/apps/v1/deployments']);
    kube.status = 429;
    await status.refresh();
    const s = en(status.snapshot());
    expect(s.light).toBe('yellow');
    const pods = s.modules.find((m) => m.id === 'pods')!;
    expect(pods.status).toBe('error');
    expect(pods.error).toBe('Could not read deployments. Showing the last known state.');
    // A module that does not read Deployments is unaffected.
    expect(s.modules.find((m) => m.id === 'nodes')!.status).toBe('ok');
    // Components are found from the last known Deployments, and their health rests on them too.
    expect(s.modules.filter((m) => m.category !== 'core').every((m) => m.status === 'error')).toBe(true);

    kube.failing.clear();
    await status.refresh();
    expect(status.snapshot().light).toBe('green');
    expect(status.state().inv.stale).toEqual([]);
  });

  it('marks a kind stale even on the first run, with nothing known yet: error, not an empty all-clear', async () => {
    const kube = new SlowKube(undefined, 'healthy');
    kube.failing = new Set(['/api/v1/persistentvolumeclaims']);
    const inv = await gatherInventory(kube, new Date());
    expect(inv.stale).toEqual(['pvcs']);
    expect(inv.pvcs).toEqual([]);
  });

  it('treats a resource that does not exist (404) as empty, not as a failed read', async () => {
    const kube = new SlowKube(undefined, 'healthy');
    kube.failing = new Set(['/apis/batch/v1/cronjobs']);
    kube.status = 404;
    // DemoKubeClient.list answers null for a 404 like the real client; a thrown 404 here models a proxy.
    const inv = await gatherInventory(kube, new Date());
    expect(inv.stale).toEqual(['cronjobs']);
    const absent = new (class extends DemoKubeClient {
      override async list<T>(path: string): Promise<T[] | null> {
        return path.startsWith('/apis/batch/v1/cronjobs') ? null : super.list<T>(path);
      }
    })(undefined, 'healthy');
    const ok = await gatherInventory(absent, new Date());
    expect(ok.stale).toEqual([]);
    expect(ok.cronjobs).toEqual([]);
  });

  it('still fails the run when nodes or pods cannot be read (the cluster counts as unreachable)', async () => {
    const kube = new SlowKube(undefined, 'healthy');
    kube.failing = new Set(['/api/v1/pods']);
    await expect(gatherInventory(kube, new Date())).rejects.toBeInstanceOf(KubeError);
  });
});
