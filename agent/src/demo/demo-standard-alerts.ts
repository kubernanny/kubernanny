/**
 * The demo Prometheus' answers to the standard alerts' queries
 * (`modules/core/standard-alerts`): a sound cluster in every scenario, except
 * that etcd on rke2-node-1 reaches rke2-node-5 slowly in `warning` and `broken`
 * (where Alertmanager fires etcdMemberCommunicationSlow for the same pair, so
 * the demo shows the two merged), shop-api-pg runs against its CPU limit of one
 * core in `warning` and `broken` (cpu-throttled), and CoreDNS answers 4.2 %
 * SERVFAIL in `broken`.
 * Matched by the exact query strings of the rule table, so no other module's
 * query is answered from here. Node RAID, kubelet certificate rotation and
 * resource quotas do not exist in the demo: those rules show as not checked.
 */
import { PROM_RULES } from '../modules/core/standard-alerts/rules';

interface Sample {
  metric: Record<string, string>;
  value: number;
}
type Scenario = 'broken' | 'warning' | 'healthy';

const NODES = [
  { name: 'rke2-node-1', ip: '10.0.0.1', member: '63044e73c12f33cd' },
  { name: 'rke2-node-4', ip: '10.0.0.4', member: 'f97a81a441cbbf08' },
  { name: 'rke2-node-5', ip: '10.0.0.5', member: 'f8e8e46b068fd5b9' },
];

/** The slow pair of `warning` and `broken`: etcd on rke2-node-1 to the member on rke2-node-5. */
export const DEMO_SLOW_PEER = { instance: '10.0.0.1:2381', To: NODES[2]!.member };

const MISSING = new Set([
  'node_md_disks',
  'node_md_disks_required',
  'kubelet_certificate_manager_client_ttl_seconds',
  'kubelet_certificate_manager_server_ttl_seconds',
  'kube_resourcequota',
]);

const etcd = (value: (n: (typeof NODES)[number]) => number): Sample[] =>
  NODES.map((n) => ({ metric: { instance: `${n.ip}:2381` }, value: value(n) }));
const exporter = (labels: Record<string, string>, value: number): Sample[] =>
  NODES.map((n) => ({ metric: { instance: `${n.ip}:9100`, ...labels }, value }));

function answers(scenario: Scenario): Record<string, Sample[] | Record<string, Sample[]>> {
  const slow = scenario !== 'healthy';
  const peers = (now: boolean): Sample[] =>
    NODES.flatMap((from, i) =>
      NODES.filter((to) => to !== from).map((to, j) => {
        const isSlow = slow && from.name === 'rke2-node-1' && to.name === 'rke2-node-5';
        return {
          metric: { instance: `${from.ip}:2381`, To: to.member },
          value: isSlow ? (now ? 0.243 : 0.212) : 0.004 + (i + j) * 0.0017,
        };
      }),
    );
  const pvcs = [
    'monitoring/data-prometheus-monitoring-chart-kube-prom-prometheus-0',
    'monitoring/data-loki-0',
    'default/shop-api-pg-1',
    'weblate/data-weblate-0',
  ].map((k) => {
    const [namespace, persistentvolumeclaim] = k.split('/');
    return { namespace: namespace!, persistentvolumeclaim: persistentvolumeclaim! };
  });
  const dnsErrors = scenario === 'broken' ? 0.042 : 0;
  // Throttled share per container: shop-api-pg's primary at its limit, the rest well below the 25 % line.
  const throttled = (hour: boolean): Sample[] => [
    {
      metric: { namespace: 'default', pod: 'shop-api-pg-1', container: 'postgres' },
      value: slow ? (hour ? 0.4 : 0.31) : 0.02,
    },
    { metric: { namespace: 'default', pod: 'shop-api-pg-2', container: 'postgres' }, value: 0.03 },
    { metric: { namespace: 'infisical', pod: 'infisical-pg-1', container: 'postgres' }, value: 0.01 },
    { metric: { namespace: 'discourse', pod: 'discourse-pg-1', container: 'postgres' }, value: hour ? 0.12 : 0.04 },
  ];
  return {
    'etcd-peer-rtt': { main: peers(false), now: peers(true) },
    'etcd-fsync': etcd(() => 0.0042),
    'etcd-commit': etcd(() => 0.0061),
    'etcd-no-leader': etcd(() => 1),
    'etcd-leader-changes': [{ metric: {}, value: 0 }],
    'etcd-db-quota': etcd(() => 0.011),
    'etcd-db-growth': etcd(() => 0.011),
    'etcd-fragmentation': { main: etcd(() => 0.82), inUse: etcd(() => 74_000_000) },
    filesystem: {
      main: exporter({ mountpoint: '/boot' }, 0.71),
      free30m: exporter({ mountpoint: '/boot' }, 0.71),
      in24h: exporter({ mountpoint: '/boot' }, 7.2e8),
      in4h: exporter({ mountpoint: '/boot' }, 7.2e8),
      readonly: exporter({ mountpoint: '/boot' }, 0),
    },
    inodes: {
      main: [...exporter({ mountpoint: '/' }, 0.94), ...exporter({ mountpoint: '/boot' }, 0.99)],
      readonly: exporter({ mountpoint: '/' }, 0),
    },
    conntrack: exporter({}, 0.031),
    'network-errors': [],
    'file-descriptors': exporter({}, 0.004),
    'node-flapping': NODES.map((n) => ({ metric: { node: n.name }, value: 0 })),
    'pv-inodes': {
      main: pvcs.map((metric) => ({ metric, value: 0.97 })),
      now: pvcs.map((metric) => ({ metric, value: 0.97 })),
      in4d: pvcs.map((metric) => ({ metric, value: 3e6 })),
    },
    'pv-errors': [],
    'client-certificate': NODES.map((n) => ({
      metric: { job: 'apiserver', instance: `${n.ip}:6443` },
      value: 287 * 86_400,
    })),
    'cpu-throttled': { main: throttled(false), hour: throttled(true) },
    'api-errors': {
      main: [{ metric: {}, value: 0.0004 }],
      m5: [{ metric: {}, value: 0 }],
      m30: [{ metric: {}, value: 0.0003 }],
      h2: [{ metric: {}, value: 0.0004 }],
      h6: [{ metric: {}, value: 0.0004 }],
      d1: [{ metric: {}, value: 0.0005 }],
    },
    'dns-errors': [{ metric: { job: 'coredns' }, value: dnsErrors }],
    'dns-latency': [{ metric: { server: 'dns://:53', zone: '.' }, value: 0.0041 }],
    'dns-forward-broken': [{ metric: {}, value: 0 }],
    'prometheus-config': [{ metric: { job: 'prometheus', instance: '10.42.1.17:9090' }, value: 1 }],
    'prometheus-rule-failures': [],
    'prometheus-alertmanager': [{ metric: { job: 'prometheus', instance: '10.42.1.17:9090' }, value: 1 }],
    'prometheus-compactions': [{ metric: { job: 'prometheus', instance: '10.42.1.17:9090' }, value: 0 }],
  };
}

/** The samples for one of the standard alerts' queries, or null when the query is not one of theirs. */
export function standardAlertsAnswer(query: string, scenario: Scenario): Sample[] | null {
  if (query.startsWith('group by (__name__) ({__name__=~"')) {
    const names = /=~"([^"]*)"/.exec(query)?.[1]?.split('|') ?? [];
    return names.filter((n) => !MISSING.has(n)).map((n) => ({ metric: { __name__: n }, value: 1 }));
  }
  if (query === 'max by (server_id, instance, pod) (etcd_server_id)') {
    return NODES.map((n) => ({
      metric: { server_id: n.member, instance: `${n.ip}:2381`, pod: `etcd-${n.name}` },
      value: 1,
    }));
  }
  for (const rule of PROM_RULES) {
    const extra = Object.entries(rule.extra ?? {}).find(([, q]) => q === query)?.[0];
    if (rule.query !== query && !extra) {
      continue;
    }
    const answer = answers(scenario)[rule.key] ?? [];
    return Array.isArray(answer) ? answer : (answer[extra ?? 'main'] ?? []);
  }
  return null;
}
