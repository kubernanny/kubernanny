/**
 * The structured parts of module sheets (`DetailSection`): one row per object
 * a module watches, problems first. Pure functions, Kubernetes objects in,
 * sections out; the integrations call them next to their checks, and the
 * judgement of what is a problem stays with the checks (a row's tone only
 * mirrors the object's own state).
 */
import { type ArgoApplication, isAutomated } from '../checks/argocd.check';
import type { Certificate } from '../checks/certificates.check';
import type { CnpgCluster } from '../checks/cnpg.check';
import type { LonghornVolume } from '../checks/longhorn.check';
import { Condition, ageText, condition } from '../checks/types';
import { MessageKey, raw, t, Text } from '../i18n/text';
import { bytes, cronText, pct } from './format';
import { parseQuantity } from '../inventory/inventory';
import type { DetailMeta, DetailRow, DetailSection, LonghornNode, Stat, Tone } from './types';

/** Rows one section carries at most; the app folds healthy rows anyway. */
const MAX_ROWS = 200;

const RANK: Record<Tone, number> = { critical: 0, warning: 1, muted: 2, ok: 3 };

/** Problems first, then by name; the order within a tone stays stable. */
function problemsFirst<T extends { tone: Tone }>(rows: T[], name?: (r: T) => string): T[] {
  return rows
    .map((r, i) => ({ r, i }))
    .sort((a, b) => RANK[a.r.tone] - RANK[b.r.tone] || (name ? name(a.r).localeCompare(name(b.r)) : 0) || a.i - b.i)
    .map((x) => x.r);
}

/** A list section, sorted problems first and cut to MAX_ROWS; null when there is nothing to list. */
export function listSection(title: Text, rows: DetailRow[], sortByName = true): DetailSection | null {
  if (rows.length === 0) {
    return null;
  }
  const sorted = problemsFirst(rows, sortByName ? (r) => (typeof r.name === 'string' ? r.name : '') : undefined);
  const more = sorted.length - MAX_ROWS;
  return { title, kind: 'list', rows: sorted.slice(0, MAX_ROWS), ...(more > 0 ? { more } : {}) };
}

export function sections(...list: (DetailSection | null)[]): DetailSection[] {
  return list.filter((s): s is DetailSection => s !== null);
}

const nsName = (m: { namespace?: string; name: string }) => (m.namespace ? `${m.namespace}/${m.name}` : m.name);

function backupMeta(at: number, now: Date, maxAgeHours: number): DetailMeta {
  if (!Number.isFinite(at)) {
    return { text: t('detail.noBackup'), tone: 'warning' };
  }
  const age = now.getTime() - at;
  return { text: t('detail.backupAgo', { age: ageText(age) }), ...(age > maxAgeHours * 3_600_000 ? { tone: 'warning' as const } : {}) };
}

/** CloudNativePG: one row per cluster with instances, primary, last backup and WAL archiving. */
/** A CNPG ScheduledBackup: its cron schedule and when it ran and runs. */
export interface CnpgScheduledBackup {
  metadata: { name: string; namespace?: string };
  spec?: { schedule?: string; suspend?: boolean; cluster?: { name?: string } };
  status?: { lastScheduleTime?: string; nextScheduleTime?: string };
}

interface CnpgClusterDetail {
  spec?: { storage?: { size?: string } };
  status?: { pgDataImageInfo?: { majorVersion?: number } };
}

export function cnpgDetails(clusters: CnpgCluster[], now: Date, maxAgeHours: number, scheduled: CnpgScheduledBackup[] = []): DetailSection[] {
  const rows = clusters.map((c): DetailRow => {
    const want = c.spec?.instances ?? 0;
    const ready = c.status?.readyInstances ?? 0;
    const archiving = condition(c.status?.conditions, 'ContinuousArchiving');
    const healthy = c.status?.phase === 'Cluster in healthy state';
    const meta: DetailMeta[] = [];
    const backups = c.spec?.backup || c.spec?.plugins?.some((p) => p.name.includes('barman'));
    if (backups || c.status?.lastSuccessfulBackup) {
      meta.push(backupMeta(Date.parse(c.status?.lastSuccessfulBackup ?? ''), now, maxAgeHours));
    }
    if (archiving) {
      meta.push(archiving.status === 'True' ? { text: t('detail.cnpg.walOk') } : { text: t('detail.cnpg.walFailing'), tone: 'critical' });
    }
    if (!healthy && c.status?.currentPrimary && c.status.phase) {
      meta.unshift({ text: t('state.cnpgPhase', { s: c.status.phase }), tone: 'warning' });
    }
    const extra = c as CnpgClusterDetail;
    if (extra.status?.pgDataImageInfo?.majorVersion) {
      meta.push({ text: t('detail.cnpg.postgres', { version: String(extra.status.pgDataImageInfo.majorVersion) }) });
    }
    if (extra.spec?.storage?.size) {
      meta.push({ text: t('detail.cnpg.storage', { size: bytes(parseQuantity(extra.spec.storage.size)) }) });
    }
    return {
      name: nsName(c.metadata),
      sub: c.status?.currentPrimary ? t('detail.cnpg.primary', { pod: c.status.currentPrimary }) : t('state.cnpgPhase', { s: c.status?.phase ?? '?' }),
      value: `${ready}/${want}`,
      tone: ready === 0 && want > 0 ? 'critical' : archiving?.status === 'False' ? 'critical' : !healthy || ready < want ? 'warning' : 'ok',
      ...(meta.length ? { meta } : {}),
    };
  });
  const plans = scheduled.map((b): DetailRow => {
    const next = Date.parse(b.status?.nextScheduleTime ?? '');
    const last = Date.parse(b.status?.lastScheduleTime ?? '');
    const meta: DetailMeta[] = [];
    if (Number.isFinite(last)) {
      meta.push({ text: t('detail.cnpg.lastRun', { age: ageText(Math.max(0, now.getTime() - last)) }) });
    }
    if (b.spec?.cluster?.name) {
      meta.push({ text: t('detail.cnpg.forCluster', { cluster: b.spec.cluster.name }) });
    }
    return {
      name: nsName(b.metadata),
      sub: b.spec?.schedule ? cronText(b.spec.schedule) : raw('?'),
      value: b.spec?.suspend ? t('detail.cnpg.suspended') : Number.isFinite(next) ? t('detail.cert.left', { age: ageText(Math.max(60_000, next - now.getTime())) }) : t('detail.unknown'),
      tone: b.spec?.suspend ? 'warning' : 'ok',
      ...(meta.length ? { meta } : {}),
    };
  });
  return sections(listSection(t('detail.cnpg.clusters'), rows), listSection(t('detail.cnpg.scheduled'), plans));
}

interface LonghornVolumeDetail {
  spec?: { size?: string; numberOfReplicas?: number };
  status?: { lastBackupAt?: string; currentNodeID?: string };
}

const ROBUSTNESS: Record<string, { text: Text; tone: Tone }> = {
  healthy: { text: t('detail.longhorn.healthy'), tone: 'ok' },
  degraded: { text: t('detail.longhorn.degraded'), tone: 'warning' },
  faulted: { text: t('detail.longhorn.faulted'), tone: 'critical' },
};

/** Longhorn: volumes by their PVC with state, robustness, size and last backup; nodes with free disk. */
/** A Longhorn replica: which volume, on which node, running or failed. */
export interface LonghornReplica {
  spec?: { volumeName?: string; nodeID?: string; failedAt?: string };
  status?: { currentState?: string };
}

export function longhornDetails(volumes: LonghornVolume[], nodes: LonghornNode[], now: Date, maxAgeHours: number, replicas: LonghornReplica[] = []): DetailSection[] {
  const byVolume = new Map<string, LonghornReplica[]>();
  for (const r of replicas) {
    const v = r.spec?.volumeName;
    if (v) {
      byVolume.set(v, [...(byVolume.get(v) ?? []), r]);
    }
  }
  const rows = volumes.map((v): DetailRow => {
    const extra = v as LonghornVolumeDetail;
    const k8s = v.status?.kubernetesStatus;
    const attached = v.status?.state === 'attached';
    const robust = ROBUSTNESS[v.status?.robustness ?? ''];
    const meta: DetailMeta[] = [];
    if (attached && robust) {
      meta.push({ text: robust.text, ...(robust.tone !== 'ok' ? { tone: robust.tone } : {}) });
    }
    const own = byVolume.get(v.metadata.name) ?? [];
    if (own.length > 0) {
      const failed = own.filter((r) => r.spec?.failedAt || (r.status?.currentState && r.status.currentState !== 'running' && attached));
      const where = [...new Set(own.map((r) => r.spec?.nodeID).filter((n): n is string => Boolean(n)))].sort();
      meta.push({ text: t('detail.longhorn.replicasOn', { n: own.length - failed.length, total: v.spec?.numberOfReplicas ?? own.length, nodes: where.join(', ') }), ...(failed.length ? { tone: 'warning' as const } : {}) });
    } else if (v.spec?.numberOfReplicas) {
      meta.push({ text: t('detail.longhorn.replicas', { n: v.spec.numberOfReplicas }) });
    }
    if (extra.status?.lastBackupAt !== undefined) {
      meta.push(extra.status.lastBackupAt ? backupMeta(Date.parse(extra.status.lastBackupAt), now, maxAgeHours) : { text: t('detail.noBackup') });
    }
    const size = Number(extra.spec?.size ?? NaN);
    return {
      name: k8s?.pvcName ? `${k8s.namespace ?? '?'}/${k8s.pvcName}` : v.metadata.name,
      sub: attached ? (extra.status?.currentNodeID ? t('detail.longhorn.attachedTo', { node: extra.status.currentNodeID }) : t('detail.longhorn.attached')) : t('detail.longhorn.detached'),
      ...(Number.isFinite(size) && size > 0 ? { value: bytes(size) } : {}),
      tone: attached ? (robust?.tone ?? 'muted') : 'muted',
      ...(meta.length ? { meta } : {}),
    };
  });
  const nodeRows = nodes.map((n) => {
    let available = 0;
    let maximum = 0;
    let scheduled = 0;
    for (const d of Object.values(n.status?.diskStatus ?? {})) {
      available += d.storageAvailable ?? 0;
      maximum += d.storageMaximum ?? 0;
      scheduled += d.storageScheduled ?? 0;
    }
    const ready = n.status?.conditions?.find((c) => c.type === 'Ready');
    const tone: Tone = ready && ready.status !== 'True' ? 'warning' : maximum > 0 && available / maximum < 0.15 ? 'warning' : 'ok';
    return {
      name: n.metadata.name,
      tone,
      cells: [n.metadata.name, maximum > 0 ? t('common.ofTotal', { part: bytes(available), total: bytes(maximum) }) : '?', maximum > 0 ? `${pct(scheduled, maximum)} %` : '?'] as (string | Text)[],
    };
  });
  const nodeSection: DetailSection | null = nodeRows.length
    ? { title: t('detail.longhorn.nodes'), kind: 'table', columns: [t('detail.col.node'), t('detail.col.free'), t('detail.col.scheduled')], rows: problemsFirst(nodeRows, (r) => r.name).map(({ tone, cells }) => ({ tone, cells })) }
    : null;
  return sections(listSection(t('detail.longhorn.volumes'), rows), nodeSection);
}

/** Argo CD: every app with health, sync state and whether it syncs by itself. */
export function argoDetails(apps: ArgoApplication[], now: Date = new Date()): DetailSection[] {
  const rows = apps.map((a): DetailRow => {
    const health = a.status?.health?.status ?? '?';
    const sync = a.status?.sync?.status ?? '?';
    const auto = isAutomated(a);
    const op = a.status?.operationState as { phase?: string; finishedAt?: string } | undefined;
    const synced = Date.parse(op?.finishedAt ?? '');
    const revision = a.status?.sync?.revision;
    const tone: Tone =
      health === 'Degraded' || health === 'Missing' ? 'critical' : sync === 'OutOfSync' && auto ? 'warning' : health === 'Progressing' || health === 'Suspended' || sync === 'OutOfSync' ? 'muted' : health === 'Healthy' ? 'ok' : 'muted';
    return {
      name: a.metadata.name,
      ...(a.spec?.destination?.namespace ? { sub: t('detail.argocd.into', { namespace: a.spec.destination.namespace }) } : {}),
      value: t('state.argoHealth', { s: health }),
      tone,
      meta: [
        { text: t('state.argoSync', { s: sync }), ...(sync === 'OutOfSync' ? { tone: auto ? ('warning' as const) : ('muted' as const) } : {}) },
        { text: auto ? t('detail.argocd.auto') : t('detail.argocd.manual') },
        ...(Number.isFinite(synced)
          ? [{ text: t('detail.argocd.lastSync', { phase: op?.phase ?? '?', age: ageText(Math.max(0, now.getTime() - synced)) }), ...(op?.phase && op.phase !== 'Succeeded' && op.phase !== 'Running' ? { tone: 'warning' as const } : {}) }]
          : []),
        ...(revision && /^[0-9a-f]{40}$/.test(revision) ? [{ text: raw(revision.slice(0, 7)) }] : []),
      ],
    };
  });
  return sections(listSection(t('detail.argocd.apps'), rows));
}

/** cert-manager: certificates by expiry, soonest first; issuers that are not ready. */
/** An ACME challenge cert-manager has not finished yet (a finished one is deleted). */
export interface AcmeChallenge {
  metadata: { name: string; namespace?: string };
  spec?: { dnsName?: string; type?: string };
  status?: { state?: string; reason?: string; presented?: boolean };
}

export function certificateDetails(
  certs: Certificate[],
  issuers: { metadata: { name: string }; status?: { conditions?: Condition[] } }[],
  now: Date,
  warnDays: number,
  criticalDays: number,
  challenges: AcmeChallenge[] = [],
): DetailSection[] {
  const rows = certs
    .map((c) => ({ c, at: Date.parse(c.status?.notAfter ?? '') }))
    .sort((a, b) => (Number.isFinite(a.at) ? a.at : Infinity) - (Number.isFinite(b.at) ? b.at : Infinity))
    .map(({ c, at }): DetailRow => {
      const ready = condition(c.status?.conditions, 'Ready')?.status === 'True';
      const left = at - now.getTime();
      const tone: Tone = !Number.isFinite(at) ? (ready ? 'muted' : 'warning') : left <= 0 || left < criticalDays * 86_400_000 ? 'critical' : left < warnDays * 86_400_000 || !ready ? 'warning' : 'ok';
      const hosts = c.spec?.dnsNames ?? [];
      const issuer = (c.spec as { issuerRef?: { name?: string } } | undefined)?.issuerRef?.name;
      const renewal = Date.parse(c.status?.renewalTime ?? '');
      const meta: DetailMeta[] = [];
      if (!ready && Number.isFinite(at)) {
        meta.push({ text: t('detail.notReady'), tone: 'warning' });
      }
      if (issuer) {
        meta.push({ text: t('detail.cert.issuer', { issuer }) });
      }
      if (Number.isFinite(renewal)) {
        // cert-manager moves renewalTime forward once it renewed; one in the past means the renewal has not worked yet.
        meta.push(renewal > now.getTime() ? { text: t('detail.cert.renews', { age: ageText(renewal - now.getTime()) }) } : { text: t('detail.cert.renewalOverdue', { age: ageText(now.getTime() - renewal) }), tone: 'warning' });
      }
      return {
        name: nsName(c.metadata),
        ...(hosts.length ? { sub: hosts.length > 1 ? t('detail.cert.hosts', { host: hosts[0]!, n: hosts.length - 1 }) : hosts[0]! } : {}),
        value: !Number.isFinite(at) ? t('detail.notReady') : left <= 0 ? t('detail.cert.expired') : t('detail.cert.left', { age: ageText(left) }),
        tone,
        ...(meta.length ? { meta } : {}),
      };
    });
  const issuerRows = issuers.map((i): DetailRow => {
    const ready = condition(i.status?.conditions, 'Ready');
    return { name: i.metadata.name, value: ready?.status === 'True' ? t('detail.ready') : t('detail.notReady'), tone: ready && ready.status !== 'True' ? 'critical' : 'ok' };
  });
  const challengeRows = challenges.map((ch): DetailRow => ({
    name: nsName(ch.metadata),
    sub: raw([ch.spec?.dnsName, ch.spec?.type].filter(Boolean).join(', ') || '?'),
    value: raw(ch.status?.state || 'pending'),
    tone: ch.status?.state === 'invalid' || ch.status?.state === 'errored' ? 'critical' : 'warning',
    ...(ch.status?.reason ? { meta: [{ text: raw(ch.status.reason) }] } : {}),
  }));
  return sections(listSection(t('detail.cert.challenges'), challengeRows), listSection(t('detail.cert.certificates'), rows, false), listSection(t('detail.cert.issuers'), issuerRows));
}

/** Prometheus: targets up and down per job, jobs with targets down first. */
export function prometheusDetails(jobs: { job: string; total: number }[], down: Map<string, string[]>): DetailSection[] {
  if (jobs.length === 0) {
    return [];
  }
  const rows = problemsFirst(
    jobs.map((j) => {
      const d = down.get(j.job)?.length ?? 0;
      return { job: j.job, tone: (d === 0 ? 'ok' : d >= j.total ? 'critical' : 'warning') as Tone, cells: [j.job, String(j.total - d), String(d)] };
    }),
    (r) => r.job,
  );
  return [{ title: t('detail.prometheus.targets'), kind: 'table', columns: [t('detail.col.job'), t('detail.col.up'), t('detail.col.down')], rows: rows.slice(0, MAX_ROWS).map(({ tone, cells }) => ({ tone, cells })) }];
}

/**
 * The condition that says whether an operator's object is in order: Ready
 * (Flux, External Secrets), else Infisical's LastReconcileStatus. The time of
 * the last successful reconcile, when the operator records one.
 */
function reconcileState(conditions: Condition[] | undefined, type = 'Ready'): { state?: Condition; lastAt: number } {
  const state = conditions?.find((c) => c.type === type);
  const success = conditions?.find((c) => c.type.endsWith('/LastSuccessfulReconcileAt'));
  const fromMessage = Date.parse(success?.message ?? '');
  return { state, lastAt: Number.isFinite(fromMessage) ? fromMessage : Date.parse(state?.lastTransitionTime ?? '') };
}

/**
 * Operators with a verdict condition (Flux, External Secrets, Infisical): one
 * list per kind with the last reconcile; the same reading of the condition as
 * `ReadyConditionIntegration`.
 */
export function readyDetails(
  lists: { kind: string; conditionType?: string; failureWhenTrue?: boolean; items: { metadata: { name: string; namespace?: string }; status?: { conditions?: Condition[] } }[] }[],
  now: Date,
): DetailSection[] {
  return sections(
    ...lists.map(({ kind, items, conditionType = 'Ready', failureWhenTrue = false }) =>
      listSection(
        raw(kind),
        items.map((item): DetailRow => {
          const { state, lastAt } = reconcileState(item.status?.conditions, conditionType);
          const decided = state?.status === 'True' || state?.status === 'False';
          const ok = decided && (state!.status === 'True') !== failureWhenTrue;
          return {
            name: nsName(item.metadata),
            ...(decided && !ok && state?.message ? { sub: raw(state.message) } : {}),
            value: ok ? t('detail.ready') : decided ? t('detail.notReady') : t('detail.unknown'),
            tone: ok ? 'ok' : decided ? 'warning' : 'muted',
            ...(Number.isFinite(lastAt) ? { meta: [{ text: t('detail.reconciled', { age: ageText(Math.max(0, now.getTime() - lastAt)) }) }] } : {}),
          };
        }),
      ),
    ),
  );
}

/** Ingress controllers: routes with failing requests first, then the busiest. */
export function routeDetails(routes: { route: string; requests: number; errors: number }[], failing: Map<string, 'critical' | 'warning'>): DetailSection[] {
  const rows = [...routes]
    .sort((a, b) => b.errors / Math.max(1, b.requests) - a.errors / Math.max(1, a.requests) || b.requests - a.requests)
    .map((r): DetailRow => {
      const share = r.requests > 0 ? (r.errors / r.requests) * 100 : 0;
      return {
        name: r.route,
        // Requests per second over the 15-minute window the error rates use.
        sub: t('detail.ingress.requests', { n: Math.round((r.requests / 900) * 100) / 100 }),
        value: t('detail.ingress.errors', { pct: Math.round(share * 10) / 10 }),
        tone: failing.get(r.route) ?? (r.requests < 1 ? 'muted' : 'ok'),
      };
    });
  return sections(listSection(t('detail.ingress.routes'), rows, false));
}

/**
 * At most four key figures: the stats named in `keys`, in that order; the
 * other facts move into a plain list under `title`, in their order.
 */
export function keyFigures(stats: Stat[], keys: MessageKey[], title: Text): { stats: Stat[]; details: DetailSection[] } {
  const figures = keys.flatMap((k) => stats.filter((s) => s.label.$t === k)).slice(0, 4);
  const rest = stats.filter((s) => !figures.includes(s));
  const rows: DetailRow[] = rest.map((s) => ({ name: s.label, value: s.value, tone: s.tone ?? 'muted' }));
  return { stats: figures, details: rows.length ? [{ title, kind: 'list', rows }] : [] };
}
