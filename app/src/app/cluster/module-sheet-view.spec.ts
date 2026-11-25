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
    expect(row!.resources.map((r) => [r.label, r.text, r.note])).toEqual([
      ['CPU', '120m', 'Requests 250m, keine Limits'],
      ['RAM', '300 MiB', 'Requests 256 MiB, Limits 512 MiB'],
    ]);
    expect(row!.pods[0]!.containers).toEqual([{ name: 'app', text: '2 Neustarts, OOMKilled am Speicherlimit von 512 MiB', oom: true }]);
  });
});

describe('node resources', () => {
  it('names requests, overbooked limits and pods without a limit per node', async () => {
    const { nodeResourceNote } = await import('../core/resources-text');
    expect(nodeResourceNote('cpu', 2500, 6400, 4000, 3, de)).toBe('Requests 2,50, Limits 6,40 (überbucht), 3 Pods ohne Limit');
    expect(nodeResourceNote('memory', 2 ** 30, 2 * 2 ** 30, 8 * 2 ** 30, 0, translatorFor('en'))).toBe('requests 1.0 GiB, limits 2.0 GiB');
  });
});
