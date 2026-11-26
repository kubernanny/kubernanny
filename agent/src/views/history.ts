import { t, Text } from '../i18n/text';
import { Inventory } from '../inventory/inventory';
import { Prometheus } from '../modules/service-proxy';
import type { HistoryPoint } from '../status/status.service';

export type Unit = 'ratio' | 'bytesPerSecond' | 'count' | 'seconds';

export interface Series {
  id: string;
  label: Text;
  unit: Unit;
  points: [number, number][];
}

export interface HistoryView {
  source: 'prometheus' | 'agent';
  hours: number;
  series: Series[];
}

const IFACE = 'device!~"lo|veth.*|cali.*|flannel.*|cni.*|vxlan.*|tunl.*|lxc.*|cilium.*|kube-ipvs.*|docker.*|br-.*"';

const CLUSTER_QUERIES: { id: string; label: Text; unit: Unit; expr: string }[] = [
  { id: 'cpu', label: t('history.cpu'), unit: 'ratio', expr: '1 - avg(rate(node_cpu_seconds_total{mode="idle"}[5m]))' },
  {
    id: 'memory',
    label: t('history.memory'),
    unit: 'ratio',
    expr: '1 - sum(node_memory_MemAvailable_bytes) / sum(node_memory_MemTotal_bytes)',
  },
  {
    id: 'net-in',
    label: t('history.netIn'),
    unit: 'bytesPerSecond',
    expr: `sum(rate(node_network_receive_bytes_total{${IFACE}}[5m]))`,
  },
  {
    id: 'net-out',
    label: t('history.netOut'),
    unit: 'bytesPerSecond',
    expr: `sum(rate(node_network_transmit_bytes_total{${IFACE}}[5m]))`,
  },
  {
    id: 'restarts',
    label: t('history.restarts'),
    unit: 'count',
    expr: 'sum(increase(kube_pod_container_status_restarts_total[10m]))',
  },
  {
    id: 'etcd-fsync',
    label: t('history.etcdFsync'),
    unit: 'seconds',
    expr: 'histogram_quantile(0.99, sum by (le) (rate(etcd_disk_wal_fsync_duration_seconds_bucket[5m])))',
  },
  {
    id: 'apiserver-p99',
    label: t('history.apiserverP99'),
    unit: 'seconds',
    expr: 'histogram_quantile(0.99, sum by (le) (rate(apiserver_request_duration_seconds_bucket{verb!~"WATCH|CONNECT"}[5m])))',
  },
];

const NODE_QUERIES: { id: string; label: Text; expr: string }[] = [
  {
    id: 'node-cpu',
    label: t('history.cpu'),
    expr: '1 - avg by (instance) (rate(node_cpu_seconds_total{mode="idle"}[5m]))',
  },
  {
    id: 'node-memory',
    label: t('history.memory'),
    expr: '1 - avg by (instance) (node_memory_MemAvailable_bytes / node_memory_MemTotal_bytes)',
  },
];

/** Maps node-exporter's `instance` ("10.0.0.4:9100" or a name) to the node name. */
function nodeResolver(inv: Inventory): (instance: string) => string {
  const byAddress = new Map<string, string>();
  for (const n of inv.nodes) {
    byAddress.set(n.metadata.name, n.metadata.name);
    for (const a of n.status?.addresses ?? []) {
      byAddress.set(a.address, n.metadata.name);
    }
  }
  return (instance) => {
    const host = instance.replace(/:\d+$/, '');
    return byAddress.get(host) ?? host;
  };
}

export async function prometheusHistory(
  prom: Prometheus,
  inv: Inventory,
  hours: number,
  now = new Date(),
): Promise<HistoryView> {
  const start = new Date(now.getTime() - hours * 3_600_000);
  // ~120 points whatever the range.
  const step = Math.max(60, Math.round((hours * 3600) / 120));
  const resolve = nodeResolver(inv);
  const cluster = await Promise.all(
    CLUSTER_QUERIES.map(async (q) => {
      const [first] = await prom.range(q.expr, start, now, step).catch(() => []);
      return first && first.points.length ? { id: q.id, label: q.label, unit: q.unit, points: first.points } : null;
    }),
  );
  const perNode = await Promise.all(
    NODE_QUERIES.map(async (q) => {
      const series = await prom.range(q.expr, start, now, step).catch(() => []);
      return series
        .filter((s) => s.metric.instance)
        .map((s) => ({
          id: `${q.id}:${resolve(s.metric.instance ?? '')}`,
          label: q.label,
          unit: 'ratio' as const,
          points: s.points,
        }));
    }),
  );
  return {
    source: 'prometheus',
    hours,
    series: [...cluster.filter((s): s is Series => s !== null), ...perNode.flat()],
  };
}

export function agentHistory(buffer: HistoryPoint[], hours: number): HistoryView {
  const since = Date.now() - hours * 3_600_000;
  const points = buffer.filter((p) => p.t >= since);
  const series: Series[] = [];
  const cpu = points.filter((p) => p.cpu !== null).map((p) => [p.t, p.cpu!] as [number, number]);
  const mem = points.filter((p) => p.memory !== null).map((p) => [p.t, p.memory!] as [number, number]);
  if (cpu.length) {
    series.push({ id: 'cpu', label: t('history.cpu'), unit: 'ratio', points: cpu });
  }
  if (mem.length) {
    series.push({ id: 'memory', label: t('history.memory'), unit: 'ratio', points: mem });
  }
  return { source: 'agent', hours, series };
}
