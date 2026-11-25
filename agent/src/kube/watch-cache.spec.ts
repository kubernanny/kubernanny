import { afterEach, describe, expect, it } from 'vitest';
import { EVENT_MAX_AGE_MS, isRelevantChange } from '../inventory/cluster-cache';
import { eventTime, stripEvent, stripNode, stripPod } from '../inventory/strip';
import { FakeWatchApi, pod, until } from '../testing/fake-watch-api';
import { Keyed, WatchCache, WatchCacheOptions, WatchEventType } from './watch-cache';

const caches: WatchCache<Keyed>[] = [];
afterEach(() => {
  caches.splice(0).forEach((c) => c.stop());
});

function podCache(api: FakeWatchApi, extra: Partial<WatchCacheOptions<Keyed>> = {}) {
  const changes: [WatchEventType, string | undefined, string | undefined][] = [];
  const cache = new WatchCache<Keyed>(api, {
    kind: 'pods',
    path: '/api/v1/pods',
    strip: stripPod as unknown as (o: unknown) => Keyed,
    onChange: (type, prev, next) => changes.push([type, prev?.metadata.resourceVersion, next?.metadata.resourceVersion]),
    minBackoffMs: 1,
    maxBackoffMs: 5,
    pageSize: 2,
    ...extra,
  });
  caches.push(cache);
  return { cache, changes };
}

describe('watch cache', () => {
  it('lists every page, then watches from the list\'s resourceVersion with bookmarks', async () => {
    const api = new FakeWatchApi();
    api.objects = [pod('a', '1'), pod('b', '2'), pod('c', '3')];
    const { cache } = podCache(api);
    cache.start();
    await cache.ready();
    expect(cache.state).toBe('synced');
    expect(cache.usable).toBe(true);
    expect(cache.items().map((p) => p.metadata.name)).toEqual(['a', 'b', 'c']);
    expect(api.requests.filter((r) => r.startsWith('GET'))).toEqual(['GET /api/v1/pods?limit=2', 'GET /api/v1/pods?limit=2&continue=2']);
    const stream = await api.stream(1);
    expect(stream.path).toMatch(/^\/api\/v1\/pods\?watch=1&allowWatchBookmarks=true&timeoutSeconds=\d+&resourceVersion=100$/);
  });

  it('applies ADDED, MODIFIED and DELETED, and tells onChange', async () => {
    const api = new FakeWatchApi();
    api.objects = [pod('a', '1')];
    const { cache, changes } = podCache(api);
    cache.start();
    const stream = await api.stream(1);
    stream.push({ type: 'ADDED', object: pod('b', '101') });
    stream.push({ type: 'MODIFIED', object: pod('a', '102', { status: { phase: 'Failed' } }) });
    stream.push({ type: 'DELETED', object: pod('b', '103') });
    await until(() => changes.length === 3);
    expect(changes).toEqual([
      ['ADDED', undefined, '101'],
      ['MODIFIED', '1', '102'],
      ['DELETED', '101', undefined],
    ]);
    expect(cache.items().map((p) => [p.metadata.name, (p as { status?: { phase?: string } }).status?.phase])).toEqual([['a', 'Failed']]);
    expect(cache.resourceVersion).toBe('103');
  });

  it('keeps only the fields the checks read', async () => {
    const api = new FakeWatchApi();
    api.objects = [pod('a', '1')];
    const { cache } = podCache(api);
    cache.start();
    await cache.ready();
    const [stored] = cache.items() as unknown as ReturnType<typeof pod>[];
    const meta = stored.metadata as Record<string, unknown>;
    expect(meta.managedFields).toBeUndefined();
    expect(meta.annotations).toEqual({ 'weave.works/kured-node-lock': 'x' });
    expect(meta.labels).toEqual({ app: 'a' });
    const container = (stored.spec as { containers: Record<string, unknown>[] }).containers[0];
    expect(Object.keys(container).sort()).toEqual(['image', 'name', 'resources']);
    expect(JSON.stringify(stored)).not.toContain('SECRET_LOOKING');

    const node = stripNode({ metadata: { name: 'n', managedFields: [{}] }, spec: { unschedulable: true, podCIDR: 'x' }, status: { images: [{ names: ['a'], sizeBytes: 1 }], conditions: [{ type: 'Ready', status: 'True' }] } });
    expect(node).toEqual({ metadata: { name: 'n' }, spec: { unschedulable: true, podCIDR: 'x' }, status: { conditions: [{ type: 'Ready', status: 'True' }] } });
    const event = stripEvent({ metadata: { name: 'e', namespace: 'd' }, message: 'm'.repeat(5000), involvedObject: { kind: 'Pod', name: 'p', namespace: 'd', uid: 'u', fieldPath: 'x' } });
    expect((event.message as string).length).toBe(1025);
    expect(event.involvedObject).toEqual({ kind: 'Pod', name: 'p', namespace: 'd' });
  });

  it('moves its resourceVersion on bookmarks and resumes the next watch from it', async () => {
    const api = new FakeWatchApi();
    const { cache, changes } = podCache(api);
    cache.start();
    const first = await api.stream(1);
    first.push({ type: 'BOOKMARK', object: { metadata: { resourceVersion: '555' } } });
    await until(() => cache.resourceVersion === '555');
    first.end();
    const second = await api.stream(2);
    expect(second.path).toContain('resourceVersion=555');
    expect(changes).toEqual([]);
    expect(api.requests.filter((r) => r.startsWith('GET'))).toHaveLength(1);
  });

  it('relists after 410 Gone, as an ERROR event or as the answer, and reports what changed meanwhile', async () => {
    const api = new FakeWatchApi();
    api.objects = [pod('a', '1'), pod('b', '2')];
    const { cache, changes } = podCache(api);
    cache.start();
    const first = await api.stream(1);
    // Meanwhile on the server: b is gone, c is new, a changed.
    api.objects = [pod('a', '7', { status: { phase: 'Failed' } }), pod('c', '8')];
    api.resourceVersion = '200';
    first.push({ type: 'ERROR', object: { kind: 'Status', code: 410, message: 'too old resource version' } });
    const second = await api.stream(2);
    expect(cache.stats.relistsAfterGone).toBe(1);
    expect(second.path).toContain('resourceVersion=200');
    expect(cache.items().map((p) => p.metadata.name).sort()).toEqual(['a', 'c']);
    expect(changes.sort()).toEqual([
      ['ADDED', undefined, '8'],
      ['DELETED', '2', undefined],
      ['MODIFIED', '1', '7'],
    ]);

    api.watchStatus = 410;
    second.end();
    await until(() => cache.stats.relistsAfterGone === 2);
    api.watchStatus = null;
    await api.stream(3);
    expect(cache.state).toBe('synced');
  });

  it('reconnects with backoff after a broken connection, keeping its objects meanwhile', async () => {
    const api = new FakeWatchApi();
    api.objects = [pod('a', '1')];
    const { cache } = podCache(api);
    cache.start();
    const first = await api.stream(1);
    first.push({ type: 'MODIFIED', object: pod('a', '150') });
    await until(() => cache.resourceVersion === '150');
    first.fail();
    const second = await api.stream(2);
    expect(second.path).toContain('resourceVersion=150');
    expect(cache.usable).toBe(true);
    expect(cache.items()).toHaveLength(1);
  });

  it('stops vouching for its objects when the watch keeps failing (no watch verb), and recovers', async () => {
    const api = new FakeWatchApi();
    api.objects = [pod('a', '1')];
    api.watchStatus = 403;
    const { cache } = podCache(api);
    cache.start();
    await until(() => cache.state === 'failed');
    expect(cache.usable).toBe(false);
    expect(cache.lastError).toContain('403');
    // The last known objects stay available for whoever wants them.
    expect(cache.items()).toHaveLength(1);
    api.watchStatus = null;
    await api.stream(1);
    await until(() => cache.state === 'synced');
  });

  it('is usable and empty when the resource does not exist (404), and failed when the list fails', async () => {
    const missing = new FakeWatchApi();
    missing.listStatus = 404;
    const { cache: absent } = podCache(missing);
    absent.start();
    await absent.ready();
    expect(absent.state).toBe('absent');
    expect(absent.usable).toBe(true);
    expect(absent.items()).toEqual([]);

    const broken = new FakeWatchApi();
    broken.listStatus = 500;
    const { cache: failed } = podCache(broken);
    failed.start();
    await failed.ready();
    expect(failed.state).toBe('failed');
    expect(failed.usable).toBe(false);
    broken.listStatus = null;
    await until(() => failed.state === 'synced');
  });

  it('relists on resync and keeps the last known objects when that relist fails', async () => {
    const api = new FakeWatchApi();
    api.objects = [pod('a', '1')];
    const { cache } = podCache(api);
    cache.start();
    await api.stream(1);
    api.listStatus = 503;
    cache.resync();
    await until(() => cache.state === 'failed');
    expect(cache.items().map((p) => p.metadata.name)).toEqual(['a']);
  });

  it('caps events by count (newest kept) and by age', async () => {
    const api = new FakeWatchApi();
    const now = Date.parse('2026-11-25T12:00:00Z');
    const ev = (name: string, minutesAgo: number) => ({ metadata: { name, namespace: 'd', resourceVersion: name }, type: 'Warning', reason: 'BackOff', lastTimestamp: new Date(now - minutesAgo * 60_000).toISOString() });
    api.objects = [ev('old', 7 * 60), ev('e1', 30), ev('e2', 20), ev('e3', 10)];
    const cache = new WatchCache<Keyed>(api, {
      kind: 'events',
      path: '/api/v1/events?fieldSelector=type%3DWarning',
      strip: stripEvent as unknown as (o: unknown) => Keyed,
      maxItems: 2,
      age: (e) => eventTime(e as never),
      keep: (e, at) => at - eventTime(e as never) <= EVENT_MAX_AGE_MS,
      now: () => now,
      minBackoffMs: 1,
    });
    caches.push(cache);
    cache.start();
    await cache.ready();
    expect(cache.items().map((e) => e.metadata.name).sort()).toEqual(['e2', 'e3']);
    expect(api.requests[0]).toBe('GET /api/v1/events?fieldSelector=type%3DWarning&limit=500');
    const stream = await api.stream(1);
    stream.push({ type: 'ADDED', object: ev('e4', 1) });
    await until(() => cache.items().some((e) => e.metadata.name === 'e4'));
    expect(cache.items().map((e) => e.metadata.name).sort()).toEqual(['e3', 'e4']);
  });
});

describe('which changes start an early run', () => {
  const p = (state: Record<string, unknown>, ready = true) => ({ metadata: { name: 'p' }, status: { phase: 'Running', conditions: [{ type: 'Ready', status: ready ? 'True' : 'False' }], containerStatuses: [{ ready, restartCount: 3, state }] } });

  it('a pod going into CrashLoopBackOff, a node going NotReady, a workload losing replicas', () => {
    expect(isRelevantChange('pods', 'MODIFIED', p({ running: {} }), p({ waiting: { reason: 'CrashLoopBackOff' } }, false))).toBe(true);
    const node = (status: string) => ({ metadata: { name: 'n' }, status: { conditions: [{ type: 'Ready', status }] } });
    expect(isRelevantChange('nodes', 'MODIFIED', node('True'), node('Unknown'))).toBe(true);
    const deploy = (ready: number) => ({ metadata: { name: 'd' }, spec: { replicas: 3 }, status: { readyReplicas: ready } });
    expect(isRelevantChange('deployments', 'MODIFIED', deploy(3), deploy(2))).toBe(true);
    expect(isRelevantChange('deployments', 'MODIFIED', deploy(2), deploy(3))).toBe(true);
  });

  it('not ordinary churn: heartbeats, restart counters in the same state, new events, healthy pods coming and going', () => {
    const crash = p({ waiting: { reason: 'CrashLoopBackOff' } }, false);
    expect(isRelevantChange('pods', 'MODIFIED', crash, { ...crash, status: { ...crash.status, containerStatuses: [{ ...crash.status.containerStatuses[0], restartCount: 4 }] } })).toBe(false);
    expect(isRelevantChange('pods', 'ADDED', undefined, p({ running: {} }))).toBe(false);
    expect(isRelevantChange('pods', 'DELETED', p({ running: {} }), undefined)).toBe(false);
    const node = { metadata: { name: 'n' }, status: { conditions: [{ type: 'Ready', status: 'True', lastHeartbeatTime: '1' }] } };
    expect(isRelevantChange('nodes', 'MODIFIED', node, { ...node, status: { conditions: [{ type: 'Ready', status: 'True', lastHeartbeatTime: '2' }] } })).toBe(false);
    expect(isRelevantChange('events', 'ADDED', undefined, { metadata: { name: 'e' } })).toBe(false);
    const deploy = (ready: number) => ({ metadata: { name: 'd' }, spec: { replicas: 3 }, status: { readyReplicas: ready } });
    expect(isRelevantChange('deployments', 'MODIFIED', deploy(1), deploy(2))).toBe(false);
  });
});
