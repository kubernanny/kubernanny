import { createServer } from 'node:http';

import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { Agent } from '../agent';
import { INTERNAL, PRINCIPAL_HEADER } from '../auth/principal';
import { Config, loadConfig } from '../config';
import { DemoKubeClient } from '../demo/demo-cluster';
import { raw, t } from '../i18n/text';
import { IncidentsService } from '../incidents/incidents.service';
import { Inventory } from '../inventory/inventory';
import { KubeClient, KubeError } from '../kube/kube-client';
import { Leader } from '../lease/leader';
import { Logger } from '../logger';
import { Episode } from '../notify/digest';
import type { IssueView } from '../status/status.service';
import { startDemoAgent } from '../testing/demo-agent';
import {
  EPISODES_KEY,
  HISTORY_CONFIGMAP,
  HistoryStore,
  MAX_EPISODES_BYTES,
  METRICS_KEY,
  parseEpisodes,
  serializeEpisodes,
} from './history-store';
import { BUCKET_MS, BUCKETS, MAX_METRICS_BYTES, MAX_NODES, MEMORY_NODES, MetricsRecorder } from './metrics-recorder';

const H = 3_600_000;
const D = 24 * H;
const PATH = `/api/v1/namespaces/kubernanny/configmaps/${HISTORY_CONFIGMAP}`;

/** The one ConfigMap the store touches, with switches to make the API fail. */
class FakeKube {
  data: Record<string, string> | null = {};
  readFails = false;
  writes: Record<string, string>[] = [];
  async get<T>(path: string): Promise<T> {
    expect(path).toBe(PATH);
    if (this.readFails) {
      throw new KubeError(503, 'etcd is busy');
    }
    if (this.data === null) {
      throw new KubeError(404, 'not found');
    }
    return { data: { ...this.data } } as T;
  }
  async mergePatch(path: string, body: { data: Record<string, string> }): Promise<void> {
    expect(path).toBe(PATH);
    if (this.data === null) {
      throw new KubeError(404, 'not found');
    }
    this.writes.push(body.data);
    this.data = { ...this.data, ...body.data };
  }
}

const config = (over: Partial<Config> = {}) => ({ namespace: 'kubernanny', historyPersist: true, ...over }) as Config;

function issue(id: string, since: number, severity: IssueView['severity'] = 'warning'): IssueView {
  return {
    id,
    check: 'pods',
    module: 'pods',
    severity,
    title: t('nodes.notReady.title', { node: id }),
    cause: raw(''),
    actions: [],
    since: new Date(since).toISOString(),
  } as IssueView;
}

/** One pod: its episode log, its metrics record and its store, on the shared ConfigMap. */
function pod(kube: FakeKube, now: () => number, leader = { on: true }, over: Partial<Config> = {}) {
  const incidents = new IncidentsService();
  const metrics = new MetricsRecorder();
  const store = new HistoryStore(config(over), kube as unknown as KubeClient, incidents, metrics, () => leader.on, now);
  return { incidents, metrics, store, leader };
}

function inventory(nodes: { name: string; cpu: number; mem: number }[]): Inventory {
  return {
    nodes: nodes.map((n) => ({
      metadata: { name: n.name },
      status: { allocatable: { cpu: '4', memory: '8Gi' } },
    })),
    nodeUsage: new Map(nodes.map((n) => [n.name, { cpuMilli: n.cpu * 4000, memBytes: n.mem * 8 * 1024 ** 3 }])),
  } as unknown as Inventory;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('episode log in the ConfigMap', () => {
  it('round-trips episodes, titles as message keys, and the first start', () => {
    const episodes: Episode[] = [
      {
        id: 'nodes/a/not-ready',
        title: t('nodes.notReady.title', { node: 'a' }),
        severity: 'critical',
        module: 'nodes',
        start: 1000,
        end: 5000,
        silenced: true,
      },
      { id: 'pods/x', title: raw('x'), severity: 'warning', module: 'pods', start: 2000, end: null, silenced: false },
    ];
    const text = serializeEpisodes(42, episodes);
    expect(JSON.parse(text)).toMatchObject({ v: 1, since: 42 });
    expect(parseEpisodes(text)).toEqual({ since: 42, episodes });
  });

  it('drops the oldest ended episodes past the size cap, never the open ones', () => {
    const long = 'x'.repeat(400);
    const episodes: Episode[] = Array.from({ length: 2000 }, (_, i) => ({
      id: `pods/${long}/${i}`,
      title: raw(long),
      severity: 'warning',
      module: 'pods',
      start: i,
      // The first ten are still open.
      end: i < 10 ? null : i + 1,
      silenced: false,
    }));
    const text = serializeEpisodes(0, episodes);
    expect(text.length).toBeLessThanOrEqual(MAX_EPISODES_BYTES);
    const kept = parseEpisodes(text)!.episodes;
    expect(kept.length).toBeLessThan(episodes.length);
    expect(kept.filter((e) => e.end === null)).toHaveLength(10);
    // The newest ended ones stay.
    expect(kept.at(-1)!.start).toBe(1999);
    expect(kept.find((e) => e.start === 10)).toBeUndefined();
  });

  it('reads garbage, another version or an oversized key as "not ours"', () => {
    expect(parseEpisodes('{nope')).toBeNull();
    expect(parseEpisodes(JSON.stringify({ v: 2, since: 1, e: [] }))).toBeNull();
    expect(parseEpisodes('"' + 'x'.repeat(MAX_EPISODES_BYTES) + '"')).toBeNull();
    // Single bad entries go, an unknown message key reads as the issue id.
    const parsed = parseEpisodes(
      JSON.stringify({
        v: 1,
        since: 1,
        e: [
          { i: 'a', t: { $t: 'gone.key' }, s: 'w', m: 'pods', a: 1, b: 2 },
          { i: 'b', t: { $t: 'raw', p: { text: 'b' } }, s: 'x', m: 'pods', a: 1 },
          { i: 'c', t: { $t: 'raw', p: { text: 'c' } }, s: 'c', m: 'pods', a: 5, b: 3 },
        ],
      }),
    );
    expect(parsed!.episodes.map((e) => [e.id, e.title])).toEqual([['a', raw('a')]]);
  });
});

describe('HistoryStore', () => {
  it('continues the week after a restart: same first start, the episodes, an open one carried on', async () => {
    const kube = new FakeKube();
    let now = Date.parse('2026-11-20T10:00:00Z');
    const first = pod(kube, () => now);
    await first.store.load();
    first.incidents.record([issue('a', now - 60_000, 'critical'), issue('b', now)], now);
    now += 10 * 60_000;
    first.incidents.record([issue('b', now)], now);
    first.metrics.sample(now, inventory([{ name: 'n1', cpu: 0.5, mem: 0.25 }]));
    await first.store.flush();
    expect(kube.writes).toHaveLength(1);

    // The new pod, an hour later.
    now += H;
    const second = pod(kube, () => now);
    await second.store.load();
    expect(second.incidents.since).toBe(first.incidents.since);
    const view = second.incidents.view(7, now);
    expect(view.coveredSince).toBe(new Date(first.incidents.since).toISOString());
    expect(view.incidents.map((i) => [i.issueId, i.end === null])).toEqual([
      ['b', true],
      ['a', false],
    ]);
    // "b" is still there on the new pod's first run: the same episode goes on, then ends.
    second.incidents.record([issue('b', now)], now);
    second.incidents.record([], now + 60_000);
    expect(second.incidents.view(7, now + 60_000).incidents.find((i) => i.issueId === 'b')!.end).not.toBeNull();
    expect(second.incidents.all().filter((e) => e.id === 'b')).toHaveLength(1);
    // The CPU and memory record came along.
    expect(second.metrics.view(6, now).series.map((s) => s.id)).toEqual([
      'cpu',
      'memory',
      'node-cpu:n1',
      'node-memory:n1',
    ]);
  });

  it('writes only on the pod in charge, at most once a minute, only what changed', async () => {
    vi.useFakeTimers();
    // At the start of a 5-minute bucket, so the CPU record does not move on during the test.
    vi.setSystemTime(Date.parse('2026-11-20T10:00:00Z'));
    try {
      const kube = new FakeKube();
      const leader = { on: false };
      const p = pod(kube, () => Date.now(), leader);
      await p.store.load();
      p.store.schedule();
      await vi.advanceTimersByTimeAsync(120_000);
      await p.store.save();
      expect(kube.writes).toHaveLength(0);

      leader.on = true;
      p.incidents.record([issue('a', Date.now())], Date.now());
      p.store.schedule();
      await vi.advanceTimersByTimeAsync(0);
      expect(kube.writes).toHaveLength(1);
      expect(Object.keys(kube.writes[0]!).sort()).toEqual([EPISODES_KEY, METRICS_KEY]);
      expect(JSON.parse(kube.writes[0]![METRICS_KEY]!).s).toEqual([]);

      // Runs within the minute: one write at its end, with only the key that changed.
      p.incidents.record([issue('a', Date.now()), issue('b', Date.now())], Date.now());
      p.store.schedule();
      p.store.schedule();
      await vi.advanceTimersByTimeAsync(30_000);
      expect(kube.writes).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(kube.writes).toHaveLength(2);
      expect(Object.keys(kube.writes[1]!)).toEqual([EPISODES_KEY]);

      // Nothing new: nothing written.
      p.store.schedule();
      await vi.advanceTimersByTimeAsync(61_000);
      expect(kube.writes).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('flushes on SIGTERM even inside the minute, and schedules nothing afterwards', async () => {
    const kube = new FakeKube();
    let now = 1_000_000_000;
    const p = pod(kube, () => now);
    await p.store.load();
    await p.store.save();
    now += 5_000;
    p.incidents.record([issue('a', now)], now);
    p.store.schedule();
    await p.store.flush();
    expect(kube.writes).toHaveLength(2);
    expect(parseEpisodes(kube.data![EPISODES_KEY]!)!.episodes.map((e) => e.id)).toEqual(['a']);
    p.store.schedule();
    expect((p.store as unknown as { timer: unknown }).timer).toBeNull();
  });

  it('logs unreadable content once, starts fresh and replaces it', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const kube = new FakeKube();
    kube.data = { [EPISODES_KEY]: '{"v":1,"since":', [METRICS_KEY]: 'garbage' };
    const now = Date.parse('2026-11-20T10:00:00Z');
    const p = pod(kube, () => now);
    await p.store.load();
    await p.store.load();
    expect(warn.mock.calls.filter(([m]) => String(m).includes('problem history unreadable'))).toHaveLength(1);
    expect(warn.mock.calls.filter(([m]) => String(m).includes('CPU and memory record unreadable'))).toHaveLength(1);
    expect(p.incidents.since).toBe(p.incidents.since);
    await p.store.save();
    expect(parseEpisodes(kube.data![EPISODES_KEY]!)).not.toBeNull();
    expect(new MetricsRecorder().restore(kube.data![METRICS_KEY]!, now)).toBe(true);
  });

  it('never overwrites a week it could not read: the read is tried again before the first write', async () => {
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const kube = new FakeKube();
    const now = Date.parse('2026-11-20T10:00:00Z');
    const old = pod(kube, () => now - 3 * D);
    old.incidents.record([issue('a', now - 3 * D)], now - 3 * D);
    old.incidents.record([], now - 3 * D + H);
    await old.store.save();
    const stored = kube.data![EPISODES_KEY];

    kube.readFails = true;
    const p = pod(kube, () => now);
    await p.store.load();
    await p.store.save();
    expect(kube.data![EPISODES_KEY]).toBe(stored);

    kube.readFails = false;
    await p.store.save();
    const after = parseEpisodes(kube.data![EPISODES_KEY]!)!;
    expect(after.since).toBe(old.incidents.since);
    expect(p.incidents.since).toBe(old.incidents.since);
    expect(after.episodes.map((e) => e.id)).toEqual(['a']);
  });

  it('keeps the history in memory when the ConfigMap is missing or persistence is off', async () => {
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const kube = new FakeKube();
    kube.data = null;
    const p = pod(kube, () => 1);
    await p.store.load();
    await p.store.save();
    expect(kube.writes).toEqual([]);

    const off = new FakeKube();
    const get = vi.spyOn(off, 'get');
    const q = pod(off, () => 1, { on: true }, { historyPersist: false });
    await q.store.load();
    await q.store.save();
    await q.store.flush();
    expect(get).not.toHaveBeenCalled();
    expect(off.writes).toEqual([]);
  });

  it('merges what the previous pod wrote last on a takeover, one episode per issue', async () => {
    const kube = new FakeKube();
    let now = Date.parse('2026-11-20T10:00:00Z');
    const old = pod(kube, () => now);
    await old.store.load();
    const neu = pod(kube, () => now, { on: false });
    await neu.store.load();
    // Both pods run; the old one saw "a" a minute earlier and saw "c" come and go before the new pod started.
    old.incidents.record([issue('a', now - 60_000), issue('c', now - 120_000)], now);
    old.incidents.record([issue('a', now - 60_000)], now + 30_000);
    neu.incidents.record([issue('a', now + 30_000)], now + 30_000);
    now += 60_000;
    await old.store.flush();
    old.leader.on = false;
    neu.leader.on = true;
    await neu.store.takeOver();
    const episodes = neu.incidents.all();
    expect(episodes.filter((e) => e.id === 'a')).toEqual([
      expect.objectContaining({ start: now - 120_000, end: null }),
    ]);
    expect(episodes.find((e) => e.id === 'c')).toMatchObject({ end: now - 30_000 });
  });
});

describe('MetricsRecorder', () => {
  const at = Date.parse('2026-11-20T10:00:00Z');

  it('keeps average and peak per 5-minute bucket, per node and for the cluster', () => {
    const r = new MetricsRecorder();
    r.sample(
      at,
      inventory([
        { name: 'a', cpu: 0.2, mem: 0.5 },
        { name: 'b', cpu: 0.4, mem: 0.5 },
      ]),
    );
    r.sample(
      at + 60_000,
      inventory([
        { name: 'a', cpu: 0.6, mem: 0.5 },
        { name: 'b', cpu: 0.4, mem: 0.5 },
      ]),
    );
    // The next bucket.
    r.sample(
      at + BUCKET_MS,
      inventory([
        { name: 'a', cpu: 0.1, mem: 0.1 },
        { name: 'b', cpu: 0.1, mem: 0.1 },
      ]),
    );
    const view = r.view(1, at + BUCKET_MS);
    expect(view).toMatchObject({ source: 'agent', hours: 1, stepSeconds: 300 });
    const a = view.series.find((s) => s.id === 'node-cpu:a')!;
    expect(a.points.map((p) => p[1])).toEqual([0.4, 0.1]);
    expect(a.max!.map((p) => p[1])).toEqual([0.6, 0.1]);
    const cluster = view.series.find((s) => s.id === 'cpu')!;
    expect(cluster.points.map((p) => p[1])).toEqual([0.4, 0.1]);
    expect(cluster.max!.map((p) => p[1])).toEqual([0.5, 0.1]);
    expect(view.series.find((s) => s.id === 'memory')!.points.map((p) => p[1])).toEqual([0.5, 0.1]);
  });

  it('records nothing without metrics-server', () => {
    const r = new MetricsRecorder();
    r.sample(at, { nodes: [], nodeUsage: null } as unknown as Inventory);
    expect(r.view(6, at).series).toEqual([]);
  });

  it('serves ~120 points for a week and forgets what is older than seven days', () => {
    const r = new MetricsRecorder();
    for (let i = 0; i < BUCKETS + 100; i++) {
      r.sample(at + i * BUCKET_MS, inventory([{ name: 'a', cpu: (i % 10) / 10, mem: 0.3 }]));
    }
    const end = at + (BUCKETS + 99) * BUCKET_MS;
    const week = r.view(168, end);
    const cpu = week.series.find((s) => s.id === 'cpu')!;
    expect(cpu.points.length).toBeGreaterThan(100);
    expect(cpu.points.length).toBeLessThanOrEqual(122);
    expect(cpu.points[0]![0]).toBeGreaterThan(end - 7 * D);
    expect(week.stepSeconds).toBe(5100);
    // A restored copy has the same week, and no bucket from before it.
    const copy = new MetricsRecorder();
    expect(copy.restore(r.serialize(end), end)).toBe(true);
    expect(copy.view(168, end)).toEqual(week);
    expect(copy.view(168, end + 7 * D).series).toEqual([]);
  });

  it('stores the cluster and the busiest MAX_NODES nodes, under the size cap even with the longest names', () => {
    const r = new MetricsRecorder();
    const nodes = Array.from({ length: 200 }, (_, i) => ({
      name: `${String(i).padStart(3, '0')}-${'n'.repeat(240)}`,
      cpu: i / 200,
      mem: i / 200,
    }));
    for (let b = 0; b < BUCKETS; b++) {
      r.sample(at + b * BUCKET_MS, inventory(nodes));
    }
    const end = at + (BUCKETS - 1) * BUCKET_MS;
    expect(r.nodeNames()).toHaveLength(MEMORY_NODES);
    const text = r.serialize(end);
    expect(text.length).toBeLessThanOrEqual(MAX_METRICS_BYTES);
    const stored = JSON.parse(text) as { s: { n: string }[] };
    expect(stored.s).toHaveLength(MAX_NODES + 1);
    expect(stored.s[0]!.n).toBe('');
    // The busiest: the highest numbers.
    expect(stored.s.slice(1).map((s) => s.n.slice(0, 3))).toEqual(
      Array.from({ length: MAX_NODES }, (_, i) => String(199 - i).padStart(3, '0')),
    );
  });

  it('keeps buckets it has over stored ones, takes the rest, and a restart within a bucket keeps its average', () => {
    const before = new MetricsRecorder();
    before.sample(at, inventory([{ name: 'a', cpu: 0.2, mem: 0.2 }]));
    before.sample(at + BUCKET_MS, inventory([{ name: 'a', cpu: 0.4, mem: 0.4 }]));
    const after = new MetricsRecorder();
    after.sample(at + BUCKET_MS + 1000, inventory([{ name: 'a', cpu: 0.8, mem: 0.8 }]));
    expect(after.restore(before.serialize(at + BUCKET_MS), at + BUCKET_MS + 1000)).toBe(true);
    expect(
      after
        .view(1, at + BUCKET_MS + 1000)
        .series.find((s) => s.id === 'cpu')!
        .points.map((p) => p[1]),
    ).toEqual([0.2, 0.8]);
    const resumed = new MetricsRecorder();
    resumed.restore(before.serialize(at + BUCKET_MS), at + BUCKET_MS + 1000);
    resumed.sample(at + BUCKET_MS + 1000, inventory([{ name: 'a', cpu: 0.8, mem: 0.8 }]));
    expect(
      resumed
        .view(1, at + BUCKET_MS + 1000)
        .series.find((s) => s.id === 'cpu')!
        .points.at(-1)![1],
    ).toBe(0.6);
  });

  it('refuses what is not its format', () => {
    const r = new MetricsRecorder();
    expect(r.restore('nope', at)).toBe(false);
    expect(r.restore(JSON.stringify({ v: 1, step: 60, end: 1, s: [] }), at)).toBe(false);
    expect(r.restore(JSON.stringify({ v: 1, step: 300, end: 1, s: [{ n: 'a', c: 1, m: 1, d: 'short' }] }), at)).toBe(
      false,
    );
  });
});

describe('the agent', () => {
  const internal = (agent: Agent) =>
    createServer((req, res) => {
      (req as typeof req & { [INTERNAL]?: true })[INTERNAL] = true;
      agent.handler(req, res);
    });

  it('serves its own record without Prometheus, marked as such, and Prometheus when there is one', async () => {
    const plain = await startDemoAgent({ DISABLED_MODULES: 'prometheus', CHECK_INTERVAL_SECONDS: '3600' });
    try {
      await plain.app.status.refresh();
      const body = (await request(internal(plain.app)).get('/api/history?hours=24').set(PRINCIPAL_HEADER, 'demo')).body;
      expect(body).toMatchObject({ source: 'agent', hours: 24, stepSeconds: 900 });
      expect(body.series.map((s: { id: string }) => s.id)).toEqual(
        expect.arrayContaining(['cpu', 'memory', 'node-cpu:rke2-node-1']),
      );
    } finally {
      await plain.close();
    }
    const withProm = await startDemoAgent({ CHECK_INTERVAL_SECONDS: '3600' });
    try {
      await withProm.app.status.refresh();
      expect(withProm.app.status.metrics.view(24, Date.now()).series).toEqual([]);
      const body = (await request(internal(withProm.app)).get('/api/history?hours=24').set(PRINCIPAL_HEADER, 'demo'))
        .body;
      expect(body.source).toBe('prometheus');
    } finally {
      await withProm.close();
    }
  });

  it('writes the history on SIGTERM before it releases the lease, and a new agent reads it before its first run', async () => {
    const kube = new DemoKubeClient(undefined, 'broken');
    await kube.create('/api/v1/namespaces/kubernanny/configmaps', {
      metadata: { name: HISTORY_CONFIGMAP },
      data: {},
    });
    const order: string[] = [];
    const leader: Leader = {
      isLeader: () => true,
      onChange: () => undefined,
      start: () => undefined,
      tryNow: async () => true,
      release: async () => {
        order.push('release');
      },
    };
    const patch = kube.mergePatch.bind(kube);
    kube.mergePatch = async (path: string, body: unknown) => {
      if (path.endsWith(HISTORY_CONFIGMAP)) {
        order.push('history');
      }
      return patch(path, body);
    };
    process.env.CHECK_INTERVAL_SECONDS = '3600';
    process.env.SHUTDOWN_DELAY_SECONDS = '0.01';
    process.env.INTERNAL_SOCKET = `/tmp/kn-h-${process.pid}.sock`;
    try {
      const cfg: Config = { ...loadConfig(), demo: null, namespace: 'kubernanny', disabledModules: ['prometheus'] };
      const first = new Agent({ kube, leader, config: cfg });
      await first.init();
      await first.status.refresh();
      await first.shutdown(100);
      expect(order.slice(0, 2)).toEqual(['history', 'release']);

      const stored = (await kube.get<{ data: Record<string, string> }>(PATH)).data;
      const since = JSON.parse(stored[EPISODES_KEY]!).since as number;
      // The demo pretends a week of watching; the stored first start survives into the next agent.
      const second = new Agent({ kube, leader, config: { ...cfg } });
      await second.init();
      expect(second.incidents.since).toBe(since);
      expect(second.status.metrics.view(1, Date.now()).series.length).toBeGreaterThan(0);
      await second.close();
    } finally {
      delete process.env.CHECK_INTERVAL_SECONDS;
      delete process.env.SHUTDOWN_DELAY_SECONDS;
      delete process.env.INTERNAL_SOCKET;
    }
  });
});
