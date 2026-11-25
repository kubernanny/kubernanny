import { describe, expect, it, vi } from 'vitest';
import { AmAlert, evaluateAlerts } from '../../../checks/alertmanager.check';
import { render } from '../../../i18n/text';
import { Inventory } from '../../../inventory/inventory';
import type { IssueView } from '../../../status/snapshot';
import type { ModuleView, RunData } from '../../types';
import { Prometheus, PromSample } from '../../service-proxy';
import { dedupeAlerts, recordAlertMatches, recordFiringAlerts } from './alertmanager-dedupe';
import { evaluateOvercommit, evaluateVersions, overcommit } from './inventory-rules';
import { PROM_RULES } from './rules';
import { runPromRules } from './standard-alerts.check';
import { Agent } from '../../../agent';
import { DemoKubeClient } from '../../../demo/demo-cluster';
import { StatusService } from '../../../status/status.service';

const node = (name: string, ip: string, cpu = '4', memory = '16Gi', kubelet = 'v1.36.6+rke2r1') => ({
  metadata: { name },
  status: { addresses: [{ type: 'InternalIP', address: ip }], allocatable: { cpu, memory }, capacity: { pods: '110' }, nodeInfo: { kubeletVersion: kubelet } },
});
const inv = (extra: Partial<Inventory> = {}) =>
  ({ nodes: [node('n1', '10.0.0.1'), node('n2', '10.0.0.2'), node('n3', '10.0.0.3')], pods: [], version: { gitVersion: 'v1.36.6+rke2r1' }, ...extra }) as unknown as Inventory;

const rule = (key: string) => PROM_RULES.find((r) => r.key === key)!;

/** A Prometheus that knows some metric names and answers some queries; everything else is empty. */
function fakeProm(present: string[], answers: Record<string, PromSample[]>) {
  const query = vi.fn(async (expr: string): Promise<PromSample[]> => {
    if (expr.startsWith('group by (__name__)')) {
      return present.map((n) => ({ metric: { __name__: n }, value: 1 }));
    }
    return answers[expr] ?? [];
  });
  return { prom: { query } as unknown as Prometheus, query };
}

const peers = (window: number, now: number): Record<string, PromSample[]> => ({
  [rule('etcd-peer-rtt').query]: [{ metric: { instance: '10.0.0.1:2381', To: 'bbb' }, value: window }],
  [rule('etcd-peer-rtt').extra!.now!]: [{ metric: { instance: '10.0.0.1:2381', To: 'bbb' }, value: now }],
  'max by (server_id, instance, pod) (etcd_server_id)': [
    { metric: { server_id: 'aaa', instance: '10.0.0.1:2381' }, value: 1 },
    { metric: { server_id: 'bbb', instance: '10.0.0.2:2381' }, value: 1 },
  ],
});

describe('standard alerts from Prometheus', () => {
  it('names both etcd members of a slow pair, with the p99 and the 150 ms threshold', async () => {
    const { prom } = fakeProm(['etcd_network_peer_round_trip_time_seconds_bucket'], peers(0.21, 0.24));
    const out = await runPromRules(prom, inv(), { alertmanager: false });
    expect(out.issues).toHaveLength(1);
    const issue = out.issues[0]!;
    expect(issue).toMatchObject({ id: 'standard-alerts/etcd-peer-rtt/n1/n2', severity: 'warning', actions: [] });
    expect(render(issue.title, 'en')).toBe('etcd n1 → n2: network round trip 240 ms');
    expect(render(issue.cause, 'en')).toContain('above 150 ms for 10 minutes (at least 210 ms)');
    expect(out.peers).toEqual([{ from: 'n1', to: 'n2', p99: 0.24 }]);
    expect(out.matches).toEqual([{ issueId: issue.id, alerts: ['etcdMemberCommunicationSlow'], labels: { instance: '10.0.0.1:2381', To: 'bbb' } }]);
  });

  it('does not alarm on a spike: the window minimum decides, as upstream `for: 10m`', async () => {
    const { prom } = fakeProm(['etcd_network_peer_round_trip_time_seconds_bucket'], peers(0.02, 0.7));
    const out = await runPromRules(prom, inv(), { alertmanager: false });
    expect(out.issues).toEqual([]);
    expect(out.peers[0]?.p99).toBe(0.7);
  });

  it('raises nothing and lists the rule as not checked when its metric is missing, and never runs its query', async () => {
    const { prom, query } = fakeProm([], peers(0.5, 0.5));
    const out = await runPromRules(prom, inv(), { alertmanager: true });
    expect(out.issues).toEqual([]);
    expect(out.states.every((s) => s.state === 'missing')).toBe(true);
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('checks the Alertmanager connection only where an Alertmanager exists', async () => {
    const q = rule('prometheus-alertmanager').query;
    const answers = { [q]: [{ metric: { job: 'prometheus', instance: '10.42.0.9:9090' }, value: 0 }] };
    const without = await runPromRules(fakeProm(['prometheus_notifications_alertmanagers_discovered'], answers).prom, inv(), { alertmanager: false });
    expect(without.issues).toEqual([]);
    expect(without.states.find((s) => s.rule.key === 'prometheus-alertmanager')?.state).toBe('not-applicable');
    const withAm = await runPromRules(fakeProm(['prometheus_notifications_alertmanagers_discovered'], answers).prom, inv(), { alertmanager: true });
    expect(withAm.issues.map((i) => i.id)).toEqual(['standard-alerts/prometheus-alertmanager/10.42.0.9:9090']);
  });

  it('judges a filesystem by space and its prediction: critical when full within 4 h, warning within 24 h, nothing for read-only', async () => {
    const r = rule('filesystem');
    const m = (mountpoint: string, instance = '10.0.0.1:9100') => ({ instance, mountpoint });
    const answers = {
      [r.query]: [{ metric: m('/data'), value: 0.08 }, { metric: m('/srv'), value: 0.12 }, { metric: m('/iso'), value: 0.01 }, { metric: m('/ok'), value: 0.5 }],
      [r.extra!.free30m!]: [{ metric: m('/data'), value: 0.08 }, { metric: m('/srv'), value: 0.12 }, { metric: m('/iso'), value: 0.01 }, { metric: m('/ok'), value: 0.5 }],
      [r.extra!.in4h!]: [{ metric: m('/data'), value: -1e9 }, { metric: m('/srv'), value: 1e9 }, { metric: m('/ok'), value: -1 }],
      [r.extra!.in24h!]: [{ metric: m('/data'), value: -1e9 }, { metric: m('/srv'), value: -1e9 }, { metric: m('/ok'), value: -1 }],
      [r.extra!.readonly!]: [{ metric: m('/iso'), value: 1 }],
    };
    const out = await runPromRules(fakeProm(['node_filesystem_avail_bytes', 'node_filesystem_size_bytes'], answers).prom, inv(), { alertmanager: false });
    expect(out.issues.map((i) => [i.id, i.severity])).toEqual([
      ['standard-alerts/filesystem/n1/data', 'critical'],
      ['standard-alerts/filesystem/n1/srv', 'warning'],
    ]);
  });
});

describe('standard alerts from the inventory', () => {
  const pod = (cpu: string, memory: string, phase = 'Running') => ({ metadata: { name: 'p' }, spec: { containers: [{ name: 'c', image: 'x', resources: { requests: { cpu, memory } } }] }, status: { phase } });

  it('warns when the requests do not fit the cluster without its largest node (KubeMemoryOvercommit)', () => {
    // 4 + 4 + 8 cores; without the 8-core node 8 remain. 9 cores requested do not fit, finished pods do not count.
    const i = inv({ nodes: [node('a', '1', '4', '16Gi'), node('b', '2', '4', '16Gi'), node('c', '3', '8', '32Gi')] as never, pods: [pod('9', '8Gi'), pod('20', '1Gi', 'Succeeded')] as never });
    const { issues, matches } = evaluateOvercommit(overcommit(i));
    expect(issues.map((x) => [x.id, x.severity, render(x.title, 'en')])).toEqual([['standard-alerts/overcommit/cpu', 'warning', 'CPU requests: the cluster cannot lose its largest node (113 %)']]);
    expect(matches).toEqual([{ issueId: 'standard-alerts/overcommit/cpu', alerts: ['KubeCPUOvercommit'], labels: {} }]);
  });

  it('never reports overcommit for a single node: there is nothing to fail over to', () => {
    expect(evaluateOvercommit(overcommit(inv({ nodes: [node('a', '1', '1', '1Gi')] as never, pods: [pod('4', '8Gi')] as never }))).issues).toEqual([]);
  });

  it('gives a hint for different minor versions', () => {
    expect(evaluateVersions(inv()).issues).toEqual([]);
    const mixed = inv({ nodes: [node('a', '1'), node('b', '2', '4', '16Gi', 'v1.35.2+rke2r1')] as never });
    expect(evaluateVersions(mixed).issues.map((x) => [x.severity, render(x.title, 'en')])).toEqual([['info', 'Different Kubernetes versions in the cluster (1.35, 1.36)']]);
  });
});

describe('Alertmanager duplicates', () => {
  const view = (id: string, issueIds: string[]): ModuleView =>
    ({ id, status: 'warning', issueIds, workloads: { ready: 1, total: 1, items: [{ kind: 'StatefulSet', namespace: 'monitoring', name: 'am', ready: 1, desired: 1 }] } }) as unknown as ModuleView;
  const asView = (module: string) => (i: ReturnType<typeof evaluateAlerts>[number]): [string, IssueView] => [i.id, { ...i, module, since: '' }];
  const slow: AmAlert = { labels: { alertname: 'etcdMemberCommunicationSlow', severity: 'warning', instance: '10.0.0.1:2381', To: 'bbb', job: 'kube-etcd' } };
  const otherPair: AmAlert = { labels: { alertname: 'etcdMemberCommunicationSlow', severity: 'warning', instance: '10.0.0.3:2381', To: 'aaa', job: 'kube-etcd' } };
  const notReady: AmAlert = { labels: { alertname: 'KubeNodeNotReady', severity: 'warning', node: 'n2' } };
  const builtIn: IssueView = { id: 'standard-alerts/etcd-peer-rtt/n1/n2', check: 'standard-alerts', module: 'standard-alerts', severity: 'warning', title: { $t: 'raw', p: { text: 'slow' } } as never, cause: { $t: 'std.etcdLeaderChanges.cause' } as never, actions: [], since: '' };

  function setup(alerts: AmAlert[], extra: IssueView[] = []) {
    const data: RunData = {};
    recordFiringAlerts(data, alerts);
    recordAlertMatches(data, [{ issueId: builtIn.id, alerts: ['etcdMemberCommunicationSlow'], labels: { instance: '10.0.0.1:2381', To: 'bbb' } }]);
    const byId = new Map<string, IssueView>([[builtIn.id, builtIn], ...extra.map((i): [string, IssueView] => [i.id, i]), ...evaluateAlerts(alerts).map(asView('alertmanager'))]);
    const am = view('alertmanager', [...byId.keys()].filter((id) => id.startsWith('alertmanager/')));
    dedupeAlerts(byId, [am], data, inv());
    return { byId, am };
  }

  it('shows the same alert once: the built-in issue stays and says Alertmanager fires it too', () => {
    const { byId, am } = setup([slow]);
    expect([...byId.keys()]).toEqual([builtIn.id]);
    expect(render(byId.get(builtIn.id)!.cause, 'en')).toMatch(/ Alertmanager fires this too \(etcdMemberCommunicationSlow\)\.$/);
    expect(am).toMatchObject({ issueIds: [], status: 'ok' });
  });

  it('keeps an alert with other labels, and rebuilds the grouped issue from what is left', () => {
    const { byId, am } = setup([slow, otherPair]);
    const left = byId.get('alertmanager/etcdMemberCommunicationSlow');
    expect(render(left!.title, 'en')).toBe('etcdMemberCommunicationSlow (10.0.0.3:2381)');
    expect(am.issueIds).toEqual(['alertmanager/etcdMemberCommunicationSlow']);
  });

  it('also merges alerts the older checks raise under their own ids (KubeNodeNotReady -> nodes/<node>/not-ready)', () => {
    const nodes: IssueView = { ...builtIn, id: 'nodes/n2/not-ready', module: 'nodes', check: 'nodes' };
    const { byId } = setup([notReady], [nodes]);
    expect(byId.has('alertmanager/KubeNodeNotReady')).toBe(false);
    expect(render(byId.get('nodes/n2/not-ready')!.cause, 'en')).toContain('(KubeNodeNotReady)');
  });

  it('leaves an alert alone when Kubernanny has no issue for it', () => {
    const { byId } = setup([notReady]);
    expect(byId.has('alertmanager/KubeNodeNotReady')).toBe(true);
    expect(render(byId.get(builtIn.id)!.cause, 'en')).not.toContain('Alertmanager');
  });
});

describe('switches', () => {
  async function run(env: Record<string, string>) {
    const saved = { ...process.env };
    Object.assign(process.env, { CHECK_INTERVAL_SECONDS: '3600', ...env });
    try {
      const kube = new DemoKubeClient(undefined, 'warning');
      const gets = vi.spyOn(kube, 'get');
      const moduleRef = new Agent({ kube: kube });
      const status = moduleRef.get(StatusService);
      await status.refresh();
      const snapshot = status.snapshot();
      await moduleRef.close();
      return { snapshot, queries: gets.mock.calls.map(([p]) => decodeURIComponent(String(p))) };
    } finally {
      process.env = saved;
    }
  }

  it('Prometheus locked off: no standard-alert query, the inventory rules still run and the sheet says what needs Prometheus', async () => {
    const { snapshot, queries } = await run({ DISABLED_MODULES: 'prometheus' });
    expect(queries.filter((q) => PROM_RULES.some((r) => q.includes(r.query)) || q.includes('group by (__name__)'))).toEqual([]);
    const m = snapshot.modules.find((x) => x.id === 'standard-alerts')!;
    expect(m.status).toBe('ok');
    expect(m.stats.at(-1)).toMatchObject({ value: { $t: 'std.needsPrometheus' } });
  });

  it('checks.disabled: [standard-alerts] runs nothing of it', async () => {
    const { snapshot, queries } = await run({ DISABLED_MODULES: 'standard-alerts' });
    expect(snapshot.modules.map((m) => m.id)).not.toContain('standard-alerts');
    expect(snapshot.issues.filter((i) => i.id.startsWith('standard-alerts/'))).toEqual([]);
    expect(queries.filter((q) => q.includes('etcd_network_peer_round_trip'))).toEqual([]);
  });
});
