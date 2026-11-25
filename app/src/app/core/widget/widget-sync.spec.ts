import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { Preferences } from '@capacitor/preferences';
import { beforeEach, describe, expect, it } from 'vitest';
import { ClusterConfig, Issue, Snapshot } from '../agent.model';
import { ClusterStore } from '../cluster-store.service';
import { ClusterState, StatusStore } from '../status-store.service';
import { WidgetBridge } from './widget-bridge';
import { WidgetCluster, keepFresher, nextWidgetList, validWidgetList, widgetCluster } from './widget-summary';
import { WidgetSync } from './widget-sync.service';

/** Stands in for the native plugin: what it holds is what the device's shared storage would hold. */
class FakeBridge {
  supported = true;
  stored: WidgetCluster[] = [];
  writes: WidgetCluster[][] = [];
  async read() {
    return this.stored;
  }
  async write(clusters: WidgetCluster[]) {
    this.writes.push(clusters);
    this.stored = clusters;
  }
}

class FakeClusters {
  readonly clusters = signal<ClusterConfig[]>([]);
  readonly loaded = Promise.resolve();
  async save(c: ClusterConfig) {
    this.clusters.set(this.clusters().map((x) => (x.id === c.id ? c : x)));
    return c;
  }
}

class FakeStatus {
  readonly states = signal<Record<string, ClusterState>>({});
}

const config = (id: string, extra: Partial<ClusterConfig> = {}): ClusterConfig => ({
  id,
  name: id,
  url: 'https://secret-host.example',
  agentKey: 'AGENTKEY'.repeat(5),
  deviceKey: 'PRIVATE-DEVICE-KEY',
  deviceId: 'dev-1',
  ...extra,
});

const issue = (severity: Issue['severity'], extra: Partial<Issue> = {}): Issue => ({
  id: `i-${Math.random()}`,
  check: 'pods',
  module: 'core',
  severity,
  title: 'Pod payments-db is crash looping',
  cause: 'OOMKilled in namespace secret-ns',
  actions: [],
  since: '2026-11-25T08:00:00Z',
  ...extra,
});

const snapshot = (light: Snapshot['light'], issues: Issue[], checkedAt = '2026-11-25T10:00:00Z'): Snapshot => ({
  cluster: 'prod-cluster',
  light,
  score: 50,
  checkedAt,
  durationMs: 100,
  kubernetes: { version: 'v1.31', distribution: 'k3s' },
  overview: null,
  modules: [],
  issues,
});

const state = (s: Snapshot): ClusterState => ({ snapshot: s, error: null, loading: false });

describe('widgetCluster', () => {
  it('counts like the headline and carries nothing but the summary and the worst titles', () => {
    const s = snapshot('red', [
      issue('warning', { title: 'Certificate expires in 9 days' }),
      issue('critical'),
      issue('critical', { title: 'Node pi-03 is not ready' }),
      issue('info', { title: 'a hint' }),
      issue('critical', { silencedUntil: '2099-01-01T00:00:00Z', title: 'silenced one' }),
    ]);
    const w = widgetCluster(config('a', { name: 'homelab' }), s);
    expect(w).toEqual({
      id: 'a',
      name: 'homelab',
      light: 'red',
      critical: 2,
      warning: 1,
      checkedAt: '2026-11-25T10:00:00Z',
      demo: false,
      problems: [
        { title: 'Pod payments-db is crash looping', severity: 'critical' },
        { title: 'Node pi-03 is not ready', severity: 'critical' },
        { title: 'Certificate expires in 9 days', severity: 'warning' },
      ],
    });
    const json = JSON.stringify(w);
    for (const secret of ['secret-host', 'AGENTKEY', 'PRIVATE-DEVICE-KEY', 'OOMKilled', 'secret-ns', 'k3s', 'prod-cluster', 'dev-1', 'a hint', 'silenced one']) {
      expect(json).not.toContain(secret);
    }
  });

  it('keeps at most three problems and shortens long titles', () => {
    const w = widgetCluster(config('a'), snapshot('red', [1, 2, 3, 4].map(() => issue('critical', { title: 'x'.repeat(200) }))));
    expect(w.problems).toHaveLength(3);
    expect(Array.from(w.problems[0]!.title)).toHaveLength(120);
    expect(widgetCluster(config('a'), snapshot('green', [])).problems).toEqual([]);
  });

  it('marks demo clusters', () => {
    expect(widgetCluster(config('demo-broken', { demo: 'broken' }), snapshot('red', [])).demo).toBe(true);
  });
});

describe('nextWidgetList', () => {
  const before: WidgetCluster = { id: 'a', name: 'old name', light: 'yellow', critical: 0, warning: 2, checkedAt: '2026-11-25T09:00:00Z', demo: false, problems: [] };

  it('keeps the last entry of a cluster without an answer, renamed', () => {
    expect(nextWidgetList([before], [config('a', { name: 'new name' })], {}, false)).toEqual([{ ...before, name: 'new name' }]);
  });

  it('leaves out switched-off and removed clusters, and everything when off', () => {
    const states = { a: state(snapshot('green', [])), b: state(snapshot('green', [])) };
    expect(nextWidgetList([before], [config('a', { widgetOff: true }), config('b')], states, false).map((c) => c.id)).toEqual(['b']);
    expect(nextWidgetList([before], [], states, false)).toEqual([]);
    expect(nextWidgetList([before], [config('a')], states, true)).toEqual([]);
  });
});

describe('validWidgetList', () => {
  it('drops malformed entries and unknown fields', () => {
    const good = { id: 'a', name: 'x', light: 'green', critical: 0, warning: 0, checkedAt: null, demo: false, problems: [{ title: 't', severity: 'warning' }] };
    expect(validWidgetList([{ ...good, extra: 'nope' }, { ...good, light: 'purple' }, { ...good, problems: [{ title: 1, severity: 'warning' }] }, null, 'x'])).toEqual([good]);
    expect(validWidgetList('nope')).toEqual([]);
  });

  it('reads a list stored before problems existed', () => {
    const old = { id: 'a', name: 'x', light: 'green', critical: 0, warning: 0, checkedAt: null, demo: false };
    expect(validWidgetList([old])).toEqual([{ ...old, problems: [] }]);
  });
});

describe('keepFresher', () => {
  const app: WidgetCluster = { id: 'a', name: 'homelab', light: 'red', critical: 1, warning: 0, checkedAt: '2026-11-25T10:00:00Z', demo: false, problems: [] };
  const pushed: WidgetCluster = { ...app, name: 'old', light: 'green', critical: 0, checkedAt: '2026-11-25T10:05:00Z' };

  it('keeps a newer state a push stored, with the app\'s name', () => {
    expect(keepFresher([app], [pushed])).toEqual([{ ...pushed, name: 'homelab' }]);
  });

  it('takes the app\'s entry when it is as new or newer, or the stored one has no time', () => {
    expect(keepFresher([{ ...app, checkedAt: '2026-11-25T10:05:00Z' }], [pushed])[0]!.light).toBe('red');
    expect(keepFresher([app], [{ ...pushed, checkedAt: null }])).toEqual([app]);
    expect(keepFresher([app], [])).toEqual([app]);
  });

  it('never brings back a cluster the app left out', () => {
    expect(keepFresher([], [pushed])).toEqual([]);
  });
});

describe('WidgetSync', () => {
  let bridge: FakeBridge;
  let clusters: FakeClusters;
  let status: FakeStatus;

  const open = async () => {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        { provide: WidgetBridge, useValue: bridge },
        { provide: ClusterStore, useValue: clusters },
        { provide: StatusStore, useValue: status },
      ],
    });
    const sync = TestBed.inject(WidgetSync);
    await sync.loaded;
    return sync;
  };
  /** Lets the effect run and the queued write finish. */
  const settle = async (sync: WidgetSync) => {
    TestBed.tick();
    await sync.sync();
  };

  beforeEach(async () => {
    bridge = new FakeBridge();
    clusters = new FakeClusters();
    status = new FakeStatus();
    await Preferences.clear();
  });

  it('writes a summary when a new snapshot arrives, and only when something changed', async () => {
    clusters.clusters.set([config('a', { name: 'homelab' }), config('demo-healthy', { name: 'Demo', demo: 'healthy' })]);
    const sync = await open();
    expect(bridge.writes).toEqual([]);

    status.states.set({ a: state(snapshot('red', [issue('critical'), issue('warning')])) });
    await settle(sync);
    expect(bridge.stored).toEqual([
      {
        id: 'a',
        name: 'homelab',
        light: 'red',
        critical: 1,
        warning: 1,
        checkedAt: '2026-11-25T10:00:00Z',
        demo: false,
        problems: [
          { title: 'Pod payments-db is crash looping', severity: 'critical' },
          { title: 'Pod payments-db is crash looping', severity: 'warning' },
        ],
      },
    ]);

    // A loading flag flipping is no new snapshot: no write.
    status.states.set({ a: { ...status.states()['a'], loading: true } });
    await settle(sync);
    expect(bridge.writes.length).toBe(1);

    status.states.set({ ...status.states(), 'demo-healthy': state(snapshot('green', [])) });
    await settle(sync);
    expect(bridge.stored.map((c) => [c.id, c.demo])).toEqual([
      ['a', false],
      ['demo-healthy', true],
    ]);
  });

  it('keeps what the widget showed while the app has no answer yet after a start', async () => {
    bridge.stored = [{ id: 'a', name: 'homelab', light: 'yellow', critical: 0, warning: 3, checkedAt: '2026-11-25T09:00:00Z', demo: false, problems: [] }];
    clusters.clusters.set([config('a', { name: 'homelab' })]);
    const sync = await open();
    await settle(sync);
    expect(bridge.writes).toEqual([]);
  });

  it('does not write an older state over one a push stored in the meantime', async () => {
    clusters.clusters.set([config('a', { name: 'homelab' }), config('b')]);
    const sync = await open();
    status.states.set({ a: state(snapshot('red', [issue('critical')], '2026-11-25T10:00:00Z')) });
    await settle(sync);
    // The push extension writes a newer, green state while the app is in the background.
    const pushed: WidgetCluster = { ...bridge.stored[0]!, light: 'green', critical: 0, problems: [], checkedAt: '2026-11-25T10:20:00Z' };
    bridge.stored = [pushed];
    // Another cluster answers: the list is written again, with the push's state for `a`.
    status.states.set({ ...status.states(), b: state(snapshot('green', [])) });
    await settle(sync);
    expect(bridge.stored.map((c) => [c.id, c.light, c.checkedAt])).toEqual([
      ['a', 'green', '2026-11-25T10:20:00Z'],
      ['b', 'green', '2026-11-25T10:00:00Z'],
    ]);
  });

  it('deletes a cluster switched off at once and writes nothing more for it', async () => {
    clusters.clusters.set([config('a'), config('b')]);
    status.states.set({ a: state(snapshot('red', [issue('critical')])), b: state(snapshot('green', [])) });
    const sync = await open();
    expect(bridge.stored.map((c) => c.id)).toEqual(['a', 'b']);

    await sync.setShown(clusters.clusters()[0], false);
    expect(bridge.stored.map((c) => c.id)).toEqual(['b']);

    status.states.set({ ...status.states(), a: state(snapshot('yellow', [issue('warning')], '2026-11-25T10:05:00Z')) });
    await settle(sync);
    expect(bridge.writes.flat().filter((c) => c.id === 'a' && c.light === 'yellow')).toEqual([]);
    expect(bridge.stored.map((c) => c.id)).toEqual(['b']);

    await sync.setShown(clusters.clusters()[0], true);
    expect(bridge.stored.map((c) => [c.id, c.light])).toEqual([
      ['a', 'yellow'],
      ['b', 'green'],
    ]);
  });

  it('switched off globally: empties the storage at once, writes nothing more, and stays off after a restart', async () => {
    clusters.clusters.set([config('a')]);
    status.states.set({ a: state(snapshot('red', [issue('critical')])) });
    let sync = await open();
    expect(bridge.stored.length).toBe(1);

    await sync.setAllOff(true);
    expect(bridge.stored).toEqual([]);
    const writes = bridge.writes.length;

    status.states.set({ a: state(snapshot('green', [], '2026-11-25T11:00:00Z')) });
    await settle(sync);
    expect(bridge.writes.length).toBe(writes);

    sync = await open();
    await settle(sync);
    expect(sync.allOff()).toBe(true);
    expect(bridge.stored).toEqual([]);
  });

  it('removes a widget entry left from before when the app starts switched off', async () => {
    await Preferences.set({ key: 'widgetsOff', value: '1' });
    bridge.stored = [{ id: 'a', name: 'homelab', light: 'red', critical: 1, warning: 0, checkedAt: null, demo: false, problems: [] }];
    clusters.clusters.set([config('a')]);
    await open();
    expect(bridge.stored).toEqual([]);
  });

  it('drops a removed cluster', async () => {
    clusters.clusters.set([config('a'), config('b')]);
    status.states.set({ a: state(snapshot('red', [])), b: state(snapshot('green', [])) });
    const sync = await open();
    clusters.clusters.set([config('b')]);
    await settle(sync);
    expect(bridge.stored.map((c) => c.id)).toEqual(['b']);
  });

  it('does nothing where there are no widgets', async () => {
    bridge.supported = false;
    clusters.clusters.set([config('a')]);
    status.states.set({ a: state(snapshot('red', [])) });
    const sync = await open();
    await settle(sync);
    expect(bridge.writes).toEqual([]);
  });
});
