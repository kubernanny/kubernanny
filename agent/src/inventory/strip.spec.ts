import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Agent } from '../agent';
import { DemoKubeClient, DemoScenario } from '../demo/demo-cluster';
import { de } from '../testing/i18n';
import { buildEvents, buildNetwork, buildNodes, buildStorage, buildWorkloads } from '../views/views';
import { stripCronJob, stripEvent, stripJob, stripNode, stripPlain, stripPod, stripService, stripWorkload } from './strip';

const STRIPS: [string, (o: unknown) => unknown][] = [
  ['/api/v1/nodes', stripNode],
  ['/api/v1/pods', stripPod],
  ['/api/v1/namespaces', stripPlain],
  ['/apis/apps/v1/', stripWorkload],
  ['/apis/batch/v1/jobs', stripJob],
  ['/apis/batch/v1/cronjobs', stripCronJob],
  ['/api/v1/services', stripService],
  ['/apis/networking.k8s.io/v1/ingresses', stripPlain],
  ['/api/v1/persistentvolumeclaims', stripPlain],
  ['/apis/storage.k8s.io/v1/storageclasses', stripPlain],
  ['/api/v1/events', stripEvent],
];

/** The demo cluster as the watch caches would hold it. */
class StrippedKube extends DemoKubeClient {
  override async list<T>(path: string): Promise<T[] | null> {
    const items = await super.list<T>(path);
    const strip = STRIPS.find(([prefix]) => path.startsWith(prefix))?.[1];
    return items && strip ? (items.map((i) => strip(JSON.parse(JSON.stringify(i)))) as T[]) : items;
  }
}

async function run(kube: DemoKubeClient) {
  process.env.CHECK_INTERVAL_SECONDS = '3600';
  const agent = new Agent({ kube });
  await agent.status.refresh();
  const { inv, data, detected } = agent.status.state();
  const snapshot = de(agent.status.snapshot());
  const views = de({ nodes: buildNodes(inv, data), workloads: buildWorkloads(inv, detected), storage: buildStorage(inv, data), network: buildNetwork(inv, data, detected), events: buildEvents(inv) });
  await agent.close();
  return { snapshot, views, inv };
}

describe('stripped objects', () => {
  // The demo dates its objects from now: one fixed now for both runs.
  beforeEach(() => {
    vi.useFakeTimers({ now: Date.parse('2026-11-25T12:00:00Z'), toFake: ['Date'] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  for (const scenario of ['broken', 'warning', 'healthy'] as DemoScenario[]) {
    it(`give every check the same result as the full objects (${scenario})`, async () => {
      const full = await run(new DemoKubeClient(undefined, scenario));
      const stripped = await run(new StrippedKube(undefined, scenario));
      const comparable = (s: typeof full.snapshot) => ({ ...s, checkedAt: null, durationMs: null, issues: s.issues.map((i) => ({ ...i, since: null })) });
      expect(comparable(stripped.snapshot)).toEqual(comparable(full.snapshot));
      expect(stripped.views).toEqual(full.views);
    });
  }
});
