import { describe, expect, it } from 'vitest';
import { ModuleView, WorkloadView } from '../core/agent.model';
import { translatorFor } from '../i18n/translator';
import { buildSheetView } from './module-sheet-view';
import { terminationText, workloadGroups } from './tabs/workloads.tab';

const de = translatorFor('de');

const module = (over: Partial<ModuleView>): ModuleView =>
  ({ id: 'cnpg', name: 'CloudNativePG', category: 'database', icon: 'server', description: '', status: 'ok', summary: '', stats: [], links: [], workloads: { ready: 0, total: 0, items: [] }, issueIds: [], ...over }) as ModuleView;

describe('module sheet', () => {
  it('keeps at most four key figures and lists what an older agent sent beyond that', () => {
    const stats = ['a', 'b', 'c', 'd', 'e', 'f'].map((label) => ({ label, value: '1' }));
    const v = buildSheetView(module({ stats, version: '1.27', namespace: 'cnpg-system' }), new Set(), de);
    expect(v.figures.map((s) => s.label)).toEqual(['a', 'b', 'c', 'd']);
    expect(v.columns).toBe(4);
    expect(v.meta).toBe('1.27, cnpg-system');
    expect(v.sections).toEqual([expect.objectContaining({ kind: 'list', title: 'Weitere Zahlen', rows: [expect.objectContaining({ name: 'e' }), expect.objectContaining({ name: 'f' })] })]);
  });

  it('shows problems always and folds healthy rows after five until expanded', () => {
    const rows = [
      ...Array.from({ length: 8 }, (_, i) => ({ name: `ok-${i}`, tone: 'ok' as const })),
      { name: 'broken', tone: 'critical' as const, meta: [{ text: 'WAL-Archiv schlägt fehl', tone: 'critical' as const }] },
    ];
    const m = module({ details: [{ title: 'Datenbank-Cluster', kind: 'list', rows }] });
    const folded = buildSheetView(m, new Set(), de).sections[0]!;
    expect(folded.kind === 'list' && folded.rows.map((r) => r.name)).toEqual(['broken', 'ok-0', 'ok-1', 'ok-2', 'ok-3', 'ok-4']);
    expect(folded.kind === 'list' && [folded.folded, folded.expandLabel, folded.count]).toEqual([3, 'Alle 9 zeigen', '1 von 9 auffällig']);
    const open = buildSheetView(m, new Set(['d0']), de).sections[0]!;
    expect(open.kind === 'list' && open.rows.length).toBe(9);
  });

  it('lists every copy of a component installed more than once', () => {
    const v = buildSheetView(
      module({ instances: [{ namespace: 'shop', name: 'valkey', version: '8.0', ready: 1, desired: 1 }, { namespace: 'argocd', name: 'redis', version: '7.2', ready: 0, desired: 1 }] }),
      new Set(),
      de,
    );
    const list = v.sections[0]!;
    expect(list.title).toBe('Instanzen');
    expect(list.kind === 'list' && list.rows.map((r) => [r.name, r.value, r.tone])).toEqual([
      ['argocd/redis', '0/1', 'critical'],
      ['shop/valkey', '1/1', 'ok'],
    ]);
  });
});

describe('workload restarts', () => {
  const now = new Date('2026-11-25T10:00:00Z');
  it('says why and when a container restarted, the memory limit next to an OOMKill', () => {
    expect(terminationText({ reason: 'OOMKilled', exitCode: 137, finishedAt: '2026-11-25T07:00:00Z', memLimit: 512 * 2 ** 20 }, now, de)).toBe('OOMKilled am Speicherlimit von 512 MiB, Exit-Code 137, vor 3 h');
    expect(terminationText({ reason: 'Error', exitCode: 1, signal: 9 }, now, translatorFor('en'))).toBe('Error, exit code 1, signal 9');
  });

  it('puts the last restart and requests and limits on the row', () => {
    const w = {
      kind: 'Deployment',
      namespace: 'shop',
      name: 'api',
      ready: 1,
      desired: 1,
      health: 'ok',
      images: [],
      restarts: 2,
      cpuMilli: 120,
      memBytes: 300 * 2 ** 20,
      resources: { cpuRequestMilli: 250, cpuLimitMilli: null, memRequest: 256 * 2 ** 20, memLimit: 512 * 2 ** 20, cpuUnlimited: 1, memUnlimited: 0 },
      lastRestart: { reason: 'OOMKilled', exitCode: 137, finishedAt: '2026-11-25T09:00:00Z', memLimit: 512 * 2 ** 20, pod: 'api-1', container: 'app' },
      pods: [{ name: 'api-1', ready: true, restarts: 2, containers: [{ name: 'app', ready: true, restarts: 2, lastTermination: { reason: 'OOMKilled', memLimit: 512 * 2 ** 20 } }] }],
    } as WorkloadView;
    const [row] = workloadGroups([w], '', 'restarts', now, de)[0]!.rows;
    expect(row!.restart).toEqual({ text: 'Letzter Neustart: OOMKilled am Speicherlimit von 512 MiB, Exit-Code 137, vor 1 h', oom: true });
    expect(row!.resources.map((r) => [r.label, r.bar.capacity, r.bar.capacityIsLimit ?? false])).toEqual([
      ['CPU', 250, false],
      ['RAM', 512 * 2 ** 20, true],
    ]);
    expect(row!.pods[0]!.containers).toEqual([{ name: 'app', text: '2 Neustarts, OOMKilled am Speicherlimit von 512 MiB', oom: true }]);
  });
});

describe('resource bar', () => {
  it('shows use, reservation and limits in cores with a comma, and overbooking with the pods without a limit', async () => {
    const { resourceBarView } = await import('../ui/resource-bar');
    const v = resourceBarView({ kind: 'cpu', used: 1730, capacity: 4000, requested: 1150, limit: 6400, withoutLimit: 8 }, 'CPU', de);
    expect([v.value, v.pct, v.tone, Math.round(v.usedPct), Math.round(v.reservedPct), v.limitPct, v.overbooked]).toEqual(['1,73 / 4 Kerne', '43 %', 'ok', 43, 29, 100, true]);
    expect(v.legend).toEqual([
      { kind: 'used', text: '1,73 genutzt' },
      { kind: 'reserved', text: '1,15 reserviert' },
      { kind: 'limit', text: '6,40 Limit', extra: '+ 8 Pods ohne Limit', over: '+60 % überbucht' },
    ]);
    expect(v.aria).toBe('CPU, 1,73 / 4 Kerne, 1,73 genutzt, 1,15 reserviert, 6,40 Limit + 8 Pods ohne Limit +60 % überbucht');
  });

  it('turns amber when requests take 90 % even at low use, coral from 90 % use', async () => {
    const { resourceBarView } = await import('../ui/resource-bar');
    expect(resourceBarView({ kind: 'memory', used: 2 ** 30, capacity: 8 * 2 ** 30, requested: 7.5 * 2 ** 30 }, 'RAM', de).tone).toBe('warning');
    expect(resourceBarView({ kind: 'memory', used: 7.5 * 2 ** 30, capacity: 8 * 2 ** 30 }, 'RAM', translatorFor('en')).tone).toBe('critical');
    expect(resourceBarView({ kind: 'cpu', used: 400, capacity: 4000, limit: 0, withoutLimit: 3 }, 'CPU', de).legend.at(-1)).toEqual({ kind: 'limit', text: 'kein Limit', extra: '+ 3 Pods ohne Limit' });
  });
});

describe('countdown to the next check', () => {
  it('says how long ago and how long until, and fills the ring', async () => {
    const { countdownView } = await import('./countdown');
    const at = Date.parse('2026-11-25T10:00:00Z');
    const s = { checkedAt: new Date(at).toISOString(), nextCheckAt: new Date(at + 60_000).toISOString() };
    const v = countdownView(s, at + 12_000, de)!;
    expect(v.text).toBe('Geprüft vor 12 s · nächste in 48 s');
    expect(v.progress).toBeCloseTo(0.2);
    expect(v.label).toMatch(/^Jetzt prüfen\. Die nächste Prüfung ist um \d\d:\d\d\.$/);
    expect(countdownView(s, at + 13_000, de, 5000)!.progress).toBeCloseTo(10 / 60);
    expect(countdownView(s, at + 61_000, de)!.text).toBe('Geprüft vor 1 min · nächste gleich');
  });

  it('shows no ring and no "next" for an agent that does not say when', async () => {
    const { countdownView } = await import('./countdown');
    const v = countdownView({ checkedAt: '2026-11-25T10:00:00Z' }, Date.parse('2026-11-25T10:03:00Z'), translatorFor('en'))!;
    expect([v.text, v.progress]).toEqual(['Checked 3 min ago', null]);
  });
});

describe('overview rail', () => {
  it('puts the small counts in one row and CPU and RAM with their nodes, problem nodes first', async () => {
    const { buildRail } = await import('./cluster-view');
    const kpi = (label: string) => ({ label, value: '1', note: '', tone: 'ok' as const });
    const node = (name: string, used: number) => ({
      name,
      cpu: { usedMilli: used, allocatableMilli: 4000, requestedMilli: 1000, limitMilli: 2000 },
      memory: { used: 2 ** 30, allocatable: 8 * 2 ** 30, requested: 2 ** 30, limit: 2 ** 31 },
      podsWithoutLimit: { cpu: 1, memory: 0 },
    });
    const cpu = { ...kpi('CPU'), bar: { kind: 'cpu' as const, used: 5000, capacity: 8000 } };
    const rail = buildRail([kpi('Nodes'), cpu, kpi('RAM'), kpi('Pods'), kpi('Volumes'), kpi('Adressen')], [node('a', 1000), node('b', 3800)], de);
    expect(rail.small.map((k) => k.label)).toEqual(['Nodes', 'Pods', 'Volumes', 'Adressen']);
    expect(rail.resources.map((r) => r.key)).toEqual(['cpu', 'memory']);
    expect(rail.resources[0]!.nodes.map((n) => [n.name, n.pct, n.problem])).toEqual([
      ['b', '95 %', true],
      ['a', '25 %', false],
    ]);
  });
});

describe('apps ready to sync', () => {
  it('lists the longest waiting first, with revisions, image tags and what changes', async () => {
    const { pendingSyncRows } = await import('./pending-syncs');
    const now = new Date('2026-11-25T12:00:00Z');
    const rows = pendingSyncRows(
      [
        { id: 'argocd/argocd/b/sync', namespace: 'argocd', app: 'b', lastSyncAt: '2026-11-25T09:00:00Z', resources: [], images: [], canSync: false },
        {
          id: 'argocd/argocd/a/sync',
          namespace: 'argocd',
          app: 'a',
          project: 'default',
          destination: 'kubernanny',
          lastSyncAt: '2026-11-24T12:00:00Z',
          syncedRevision: 'aee71e4',
          targetRevision: 'e7eb06b',
          resources: [{ kind: 'Role', name: 'keys', change: 'new' }],
          images: [{ from: 'ghcr.io/kubernanny/agent:2026-11-25-11', to: 'ghcr.io/kubernanny/agent:2026-11-25-14' }],
          canSync: true,
        },
      ],
      now,
      de,
    );
    expect(rows.map((r) => r.app)).toEqual(['a', 'b']);
    expect(rows[0]).toMatchObject({ where: 'nach kubernanny, Projekt default', since: 'wartet seit dem letzten Sync vor 24 h', revisions: 'aee71e4 → e7eb06b', images: ['agent:2026-11-25-11 → 2026-11-25-14'], canSync: true });
    expect(rows[0]!.resources).toEqual([{ key: 'Role//keys', text: 'Role keys', change: 'new', label: 'neu' }]);
  });
});
