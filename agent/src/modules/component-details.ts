/**
 * What every recognised component's sheet shows from the inventory alone,
 * with or without an integration: its pods (node, ready, restarts and why the
 * last run ended), CPU and RAM against requests and limits per workload, and
 * the volumes its pods mount with size and fill. Appended after the
 * integration's own sections, so Redis, pgAdmin or CoreDNS get a useful sheet
 * too. Pure: inventory in, sections out.
 */
import { podOwner, podReady } from '../checks/pods.check';
import { ageText } from '../checks/types';
import type { Detected } from '../discovery/discovery';
import { raw, t, Text } from '../i18n/text';
import { FullPod, Inventory, parseQuantity } from '../inventory/inventory';
import { containerViews } from '../views/workloads';
import { addResources, NO_RESOURCES, podResources } from '../views/resources';
import { listSection, sections } from './details';
import { bytes, pct } from './format';
import type { DetailMeta, DetailRow, DetailSection, RunData, Stat, Tone } from './types';

const BROKEN = new Set(['CrashLoopBackOff', 'ImagePullBackOff', 'ErrImagePull', 'CreateContainerConfigError', 'CreateContainerError', 'RunContainerError']);

export const cores = (milli: number): Text => t('detail.cores', { milli: Math.round(milli) });

/** The pods of a detected component's workloads. */
export function podsOf(inv: Inventory, d: Pick<Detected, 'workloads'>): FullPod[] {
  const keys = new Set(d.workloads.map((w) => `${w.namespace}/${w.kind}/${w.name}`));
  return inv.pods.filter((p) => {
    const o = podOwner(p);
    return keys.has(`${p.metadata.namespace}/${o.kind}/${o.name}`);
  });
}

/** "OOMKilled at the limit of 512 MiB, exit code 137, 3 h ago". */
export function terminationMeta(term: { reason?: string; exitCode?: number; finishedAt?: string; memLimit?: number }, now: Date): DetailMeta {
  const at = Date.parse(term.finishedAt ?? '');
  const when = Number.isFinite(at) ? t('common.ago', { age: ageText(Math.max(0, now.getTime() - at)) }) : undefined;
  if (term.reason === 'OOMKilled') {
    return { text: term.memLimit ? t('detail.pod.oomLimit', { limit: bytes(term.memLimit), when }) : t('detail.pod.oom', { when }), tone: 'warning' };
  }
  return { text: t('detail.pod.lastExit', { reason: term.reason ?? '?', code: term.exitCode ?? 0, when }) };
}

function podRows(pods: FullPod[], inv: Inventory, now: Date): DetailRow[] {
  return pods.map((p) => {
    const containers = containerViews(p);
    const waiting = containers.map((c) => c.waiting).find(Boolean);
    const restarts = containers.reduce((s, c) => s + c.restarts, 0);
    const ready = podReady(p);
    const last = containers
      .filter((c) => c.restarts > 0 && c.lastTermination)
      .sort((a, b) => (b.lastTermination!.finishedAt ?? '').localeCompare(a.lastTermination!.finishedAt ?? ''))[0]?.lastTermination;
    const usage = inv.podUsage?.get(`${p.metadata.namespace}/${p.metadata.name}`);
    const tone: Tone = p.status?.phase === 'Succeeded' ? 'muted' : ready ? (last?.reason === 'OOMKilled' ? 'warning' : 'ok') : waiting && BROKEN.has(waiting) ? 'critical' : 'warning';
    const meta: DetailMeta[] = [];
    if (restarts > 0) {
      meta.push({ text: t('detail.pod.restarts', { n: restarts }) });
    }
    if (last) {
      meta.push(terminationMeta(last, now));
    }
    if (usage) {
      meta.push({ text: t('detail.cpuMem', { cpu: cores(usage.cpuMilli), mem: bytes(usage.memBytes) }) });
    }
    return {
      name: p.metadata.name,
      sub: t('detail.pod.where', { node: p.spec?.nodeName ?? '?', namespace: p.metadata.namespace ?? '' }),
      value: waiting ? raw(waiting) : ready ? t('detail.ready') : raw(p.status?.phase ?? '?'),
      tone,
      ...(meta.length ? { meta } : {}),
    };
  });
}

/** Per workload: use against requests and limits, amber from 90 % of a memory limit. */
function resourceRows(d: Pick<Detected, 'workloads'>, pods: FullPod[], inv: Inventory): DetailRow[] {
  return d.workloads
    .filter((w) => w.kind !== 'CronJob')
    .map((w) => {
      const own = pods.filter((p) => {
        const o = podOwner(p);
        return p.metadata.namespace === w.namespace && o.kind === w.kind && o.name === w.name && p.status?.phase !== 'Succeeded' && p.status?.phase !== 'Failed';
      });
      const res = own.map(podResources).reduce(addResources, NO_RESOURCES);
      let cpu: number | null = inv.podUsage ? 0 : null;
      let mem: number | null = inv.podUsage ? 0 : null;
      for (const p of own) {
        const u = inv.podUsage?.get(`${p.metadata.namespace}/${p.metadata.name}`);
        if (u && cpu !== null && mem !== null) {
          cpu += u.cpuMilli;
          mem += u.memBytes;
        }
      }
      const memShare = mem !== null && res.memLimit > 0 && res.memUnlimited === 0 ? mem / res.memLimit : null;
      const meta: DetailMeta[] = [
        { text: t('detail.res.requests', { cpu: cores(res.cpuRequestMilli), mem: bytes(res.memRequest) }) },
        res.cpuLimitMilli === 0 && res.memLimit === 0
          ? { text: t('detail.res.noLimits') }
          : {
              text: t('detail.res.limits', { cpu: res.cpuUnlimited ? t('detail.res.none') : cores(res.cpuLimitMilli), mem: res.memUnlimited ? t('detail.res.none') : bytes(res.memLimit) }),
              ...(memShare !== null && memShare >= 0.9 ? { tone: 'warning' as const } : {}),
            },
      ];
      return {
        name: `${w.namespace}/${w.name}`,
        sub: raw(w.kind),
        ...(cpu !== null && mem !== null ? { value: t('detail.cpuMem', { cpu: cores(cpu), mem: bytes(mem) }) } : {}),
        tone: (memShare !== null && memShare >= 0.9 ? 'warning' : 'ok') as Tone,
        meta,
      };
    });
}

/** The PVCs the component's pods mount, with size and fill. */
function volumeRows(pods: FullPod[], inv: Inventory, data: RunData): DetailRow[] {
  const seen = new Set<string>();
  const rows: DetailRow[] = [];
  for (const p of pods) {
    for (const v of p.spec?.volumes ?? []) {
      const claim = v.persistentVolumeClaim?.claimName;
      const key = `${p.metadata.namespace}/${claim}`;
      if (!claim || seen.has(key)) {
        continue;
      }
      seen.add(key);
      const pvc = inv.pvcs.find((x) => x.metadata.namespace === p.metadata.namespace && x.metadata.name === claim);
      const size = parseQuantity(pvc?.status?.capacity?.storage ?? pvc?.spec?.resources?.requests?.storage);
      const use = data.volumeUsage?.get(key);
      const fill = use && use.capacity > 0 ? pct(use.used, use.capacity) : null;
      rows.push({
        name: key,
        ...(pvc?.spec?.storageClassName ? { sub: raw(pvc.spec.storageClassName) } : {}),
        ...(size > 0 ? { value: bytes(size) } : {}),
        tone: pvc?.status?.phase && pvc.status.phase !== 'Bound' ? 'warning' : fill !== null && fill >= 85 ? 'warning' : 'ok',
        ...(fill !== null ? { meta: [{ text: t('detail.volume.fill', { pct: fill }), ...(fill >= 85 ? { tone: 'warning' as const } : {}) }] } : {}),
      });
    }
  }
  return rows;
}

/** Pods, resources and volumes of one recognised component. */
export function componentDetails(inv: Inventory, data: RunData, d: Pick<Detected, 'workloads'>, now: Date): DetailSection[] {
  const pods = podsOf(inv, d);
  return sections(
    listSection(t('detail.pods'), podRows(pods, inv, now)),
    listSection(t('detail.resources'), resourceRows(d, pods, inv)),
    listSection(t('detail.volumes'), volumeRows(pods, inv, data)),
  );
}

/** Key figures of a component without an integration: pods ready, restarts, and what it uses. */
export function componentStats(inv: Inventory, d: Pick<Detected, 'workloads'>): Stat[] {
  const pods = podsOf(inv, d).filter((p) => p.status?.phase !== 'Succeeded' && p.status?.phase !== 'Failed');
  if (pods.length === 0) {
    return [];
  }
  const ready = pods.filter(podReady).length;
  const restarts = pods.reduce((s, p) => s + (p.status?.containerStatuses ?? []).reduce((x, c) => x + c.restartCount, 0), 0);
  const stats: Stat[] = [
    { label: t('stat.podsReady'), value: `${ready}/${pods.length}`, tone: ready === pods.length ? 'ok' : ready === 0 ? 'critical' : 'warning' },
    { label: t('pods.stat.restarts'), value: String(restarts), tone: restarts > 0 ? 'muted' : 'ok' },
  ];
  if (inv.podUsage) {
    let cpu = 0;
    let mem = 0;
    for (const p of pods) {
      const u = inv.podUsage.get(`${p.metadata.namespace}/${p.metadata.name}`);
      cpu += u?.cpuMilli ?? 0;
      mem += u?.memBytes ?? 0;
    }
    stats.push({ label: t('stat.cpu'), value: cores(cpu) }, { label: t('stat.ram'), value: bytes(mem) });
  }
  return stats;
}
