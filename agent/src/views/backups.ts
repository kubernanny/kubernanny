/**
 * The Backups view: one row per protected thing (a database, a volume, etcd, a
 * Velero schedule) with its last success and the same verdict the checks
 * reach. Built from what the modules read in the last run (RunData), so it
 * makes no API call of its own and knows only what is switched on.
 */
import { CnpgCluster, hasBackup } from '../checks/cnpg.check';
import { LonghornVolume } from '../checks/longhorn.check';
import { EtcdSnapshot, LonghornBackup, LonghornBackupTarget, groupLonghornBackups, longhornBackupTime } from '../checks/maintenance.check';
import { condition } from '../checks/types';
import { Text, raw, t } from '../i18n/text';
import { MANUAL, VeleroBackup, newestBySchedule } from '../modules/integrations/velero';
import { RunData } from '../modules/types';

export type BackupKind = 'cnpg' | 'longhorn' | 'etcd' | 'velero';
export type BackupState = 'ok' | 'warning' | 'critical';
export type BackupTargetType = 's3' | 'azure' | 'gcs' | 'nfs' | 'cifs' | 'local' | 'unknown';

export interface BackupTarget {
  type: BackupTargetType;
  /** Where, as configured (bucket and path, NFS export, Velero storage location); never credentials. */
  location?: string;
}

export interface BackupRow {
  /** Stable: kind, namespace, name. */
  id: string;
  kind: BackupKind;
  /** The database cluster, the volume's PVC (else the Longhorn volume), `etcd`, or the Velero schedule. */
  name: Text;
  namespace?: string;
  /** ISO time of the last successful backup; null when there was none. */
  lastSuccess: string | null;
  /** Age of that backup in ms at the time of the run; null when there was none. */
  ageMs: number | null;
  state: BackupState;
  /** Why the state is not ok; absent when it is. */
  note?: Text;
  target: BackupTarget | null;
  /** Backups (or snapshots) the cluster still lists for it; null where only the last one is known (CNPG). */
  count: number | null;
}

export interface BackupTargetView {
  kind: 'longhorn';
  name: string;
  type: BackupTargetType;
  location: string;
  /** null while Longhorn has not checked it yet. */
  available: boolean | null;
}

export interface UnprotectedView {
  kind: 'cnpg' | 'longhorn';
  name: string;
  namespace?: string;
}

export interface BackupsView {
  /** The threshold the checks use (BACKUP_MAX_AGE_HOURS): older is a warning, twice as old critical. */
  maxAgeHours: number;
  /** Worst first, then by kind and name. */
  rows: BackupRow[];
  targets: BackupTargetView[];
  /** Databases without a backup configured, volumes without any backup. Not judged: not every volume needs one. */
  unprotected: UnprotectedView[];
  /**
   * Backups Longhorn still keeps in its target for volumes that were deleted
   * (`volumes` distinct deleted volumes, `backups` in all). They protect
   * nothing and get no row; absent when there are none.
   */
  orphaned?: { kind: 'longhorn'; volumes: number; backups: number };
}

const H = 3_600_000;
const RANK: Record<BackupState, number> = { critical: 0, warning: 1, ok: 2 };

/**
 * The age rule every backup check applies: older than the limit a warning,
 * twice as old critical. `never` is what the check says when there was no
 * success at all (CNPG: a warning; Longhorn and etcd count it as infinitely old).
 */
export function ageState(ageMs: number | null, maxAgeHours: number, never: BackupState): BackupState {
  if (ageMs === null) {
    return never;
  }
  return ageMs > 2 * maxAgeHours * H ? 'critical' : ageMs > maxAgeHours * H ? 'warning' : 'ok';
}

/** The kind of storage behind a backup URL; the location without a query string (NFS mount options). */
export function targetFromUrl(url: string | undefined): BackupTarget | null {
  if (!url) {
    return null;
  }
  const location = url.split('?')[0]!;
  const scheme = /^([a-z0-9+.-]+):\/\//i.exec(location)?.[1]?.toLowerCase();
  const type: BackupTargetType =
    scheme === 's3'
      ? 's3'
      : scheme === 'gs'
        ? 'gcs'
        : scheme === 'azblob' || /\.blob\.core\.windows\.net/.test(location)
          ? 'azure'
          : scheme === 'nfs'
            ? 'nfs'
            : scheme === 'cifs' || scheme === 'smb'
              ? 'cifs'
              : scheme === 'file' || location.startsWith('/')
                ? 'local'
                : 'unknown';
  return { type, location };
}

const worse = (a: BackupState, b: BackupState): BackupState => (RANK[a] <= RANK[b] ? a : b);

function cnpgRows(clusters: CnpgCluster[], now: number, maxAgeHours: number): { rows: BackupRow[]; unprotected: UnprotectedView[] } {
  const rows: BackupRow[] = [];
  const unprotected: UnprotectedView[] = [];
  for (const c of clusters) {
    const ns = c.metadata.namespace ?? 'default';
    if (!hasBackup(c)) {
      unprotected.push({ kind: 'cnpg', name: c.metadata.name, namespace: ns });
      continue;
    }
    const lastOk = Date.parse(c.status?.lastSuccessfulBackup ?? '');
    const ageMs = Number.isFinite(lastOk) ? now - lastOk : null;
    let state = ageState(ageMs, maxAgeHours, 'warning');
    let note: Text | undefined = ageMs === null ? t('backups.note.none') : state !== 'ok' ? t('backups.note.overdue', { hours: maxAgeHours }) : undefined;
    // Without WAL archiving a restore loses everything since the last base backup: the check calls it critical.
    if (condition(c.status?.conditions, 'ContinuousArchiving')?.status === 'False') {
      state = 'critical';
      note = t('backups.note.archiving');
    }
    rows.push({
      id: `cnpg/${ns}/${c.metadata.name}`,
      kind: 'cnpg',
      name: raw(c.metadata.name),
      namespace: ns,
      lastSuccess: ageMs === null ? null : new Date(lastOk).toISOString(),
      ageMs,
      state,
      ...(note ? { note } : {}),
      // The barman-cloud plugin keeps its destination in an ObjectStore resource the agent does not read.
      target: targetFromUrl(c.spec?.backup?.barmanObjectStore?.destinationPath) ?? (c.spec?.plugins?.length ? { type: 'unknown' } : null),
      count: null,
    });
  }
  return { rows, unprotected };
}

function longhornRows(
  backups: LonghornBackup[],
  targets: LonghornBackupTarget[],
  volumes: LonghornVolume[],
  now: number,
  maxAgeHours: number,
): { rows: BackupRow[]; targets: BackupTargetView[]; unprotected: UnprotectedView[]; orphaned: { volumes: number; backups: number } } {
  const targetViews: BackupTargetView[] = targets
    .filter((x) => x.spec?.backupTargetURL)
    .map((x) => ({ kind: 'longhorn', name: x.metadata.name, type: targetFromUrl(x.spec!.backupTargetURL)!.type, location: targetFromUrl(x.spec!.backupTargetURL)!.location!, available: x.status?.available ?? null }));
  const main = targetViews.find((x) => x.name === 'default') ?? targetViews[0];
  const unreachable = targetViews.some((x) => x.available === false);
  const time = longhornBackupTime;
  // Only volumes that exist now: the target keeps backups of deleted volumes, which get a count, not a row.
  const { byVolume, orphaned } = groupLonghornBackups(volumes, backups);
  const rows: BackupRow[] = [];
  for (const v of volumes) {
    const volume = v.metadata.name;
    const list = byVolume.get(volume);
    if (!list) {
      continue;
    }
    const sorted = list.filter((b) => Number.isFinite(time(b))).sort((a, b) => time(b) - time(a));
    const lastOk = sorted.find((b) => b.status?.state === 'Completed');
    const ageMs = lastOk ? now - time(lastOk) : null;
    // As the check: recurring jobs skip detached volumes, so their age is no fault (a hint there, ok here).
    const detached = v.status?.state === 'detached';
    let state = detached ? 'ok' : ageState(ageMs, maxAgeHours, 'critical');
    let note: Text | undefined =
      detached && (ageMs === null || ageMs > maxAgeHours * H)
        ? t('backups.note.detached')
        : ageMs === null
          ? t('backups.note.none')
          : state !== 'ok'
            ? t('backups.note.overdue', { hours: maxAgeHours })
            : undefined;
    if (sorted[0]?.status?.state === 'Error') {
      // As the check: a failed newest backup is a warning however recent the last good one is.
      state = worse(state, 'warning');
      note = t('backups.note.lastFailed');
    }
    if (unreachable) {
      state = 'critical';
      note = t('backups.note.targetUnreachable');
    }
    const k8s = v.status?.kubernetesStatus;
    rows.push({
      id: `longhorn/${volume}`,
      kind: 'longhorn',
      name: raw(k8s?.pvcName ?? volume),
      ...(k8s?.namespace ? { namespace: k8s.namespace } : {}),
      lastSuccess: lastOk ? new Date(time(lastOk)).toISOString() : null,
      ageMs,
      state,
      ...(note ? { note } : {}),
      target: main ? { type: main.type, location: main.location } : null,
      count: list.length,
    });
  }
  // Only volumes a workload uses: detached leftovers are not worth a line.
  const unprotected: UnprotectedView[] = volumes
    .filter((v) => !byVolume.has(v.metadata.name) && v.status?.state === 'attached')
    .map((v) => ({ kind: 'longhorn', name: v.status?.kubernetesStatus?.pvcName ?? v.metadata.name, ...(v.status?.kubernetesStatus?.namespace ? { namespace: v.status.kubernetesStatus.namespace } : {}) }));
  return { rows, targets: targetViews, unprotected, orphaned };
}

function etcdRow(snapshots: EtcdSnapshot[], now: number, maxAgeHours: number): BackupRow {
  const time = (s: EtcdSnapshot) => Date.parse(s.status?.creationTime ?? s.metadata.creationTimestamp ?? '');
  const sorted = snapshots.filter((s) => Number.isFinite(time(s))).sort((a, b) => time(b) - time(a));
  const lastGood = sorted.find((s) => s.status?.readyToUse !== false && !s.status?.error);
  const ageMs = lastGood ? now - time(lastGood) : null;
  // No snapshot at all is a warning in the check (snapshots may be off), none usable among several critical.
  let state = ageState(ageMs, maxAgeHours, snapshots.length === 0 ? 'warning' : 'critical');
  let note: Text | undefined = ageMs === null ? t('backups.note.none') : state !== 'ok' ? t('backups.note.overdue', { hours: maxAgeHours }) : undefined;
  if (sorted[0]?.status?.error) {
    state = worse(state, 'warning');
    note = t('backups.note.lastFailed');
  }
  const where = lastGood ?? sorted[0];
  const target: BackupTarget | null = where
    ? where.spec?.s3
      ? { type: 's3', ...(where.spec.location ? { location: where.spec.location.split('?')[0] } : {}) }
      : { type: 'local', ...(where.spec?.nodeName ? { location: where.spec.nodeName } : {}) }
    : null;
  return {
    id: 'etcd',
    kind: 'etcd',
    name: raw('etcd'),
    lastSuccess: lastGood ? new Date(time(lastGood)).toISOString() : null,
    ageMs,
    state,
    ...(note ? { note } : {}),
    target,
    count: snapshots.length,
  };
}

function veleroRows(backups: VeleroBackup[], now: number, maxAgeHours: number): BackupRow[] {
  const rows: BackupRow[] = [];
  const completedAt = (b: VeleroBackup) => Date.parse(b.status?.completionTimestamp ?? b.metadata.creationTimestamp ?? '');
  for (const [schedule, newest] of newestBySchedule(backups)) {
    const own = backups.filter((b) => (b.metadata.labels?.['velero.io/schedule-name'] ?? MANUAL) === schedule);
    const lastOk = own
      .filter((b) => b.status?.phase === 'Completed' && Number.isFinite(completedAt(b)))
      .sort((a, b) => completedAt(b) - completedAt(a))[0];
    const ageMs = lastOk ? now - completedAt(lastOk) : null;
    const phase = newest.status?.phase;
    const newestAge = now - completedAt(newest);
    // The same verdict as the Velero check: the newest run's phase, and for schedules its age (never critical by age).
    let state: BackupState = 'ok';
    let note: Text | undefined;
    if (phase === 'Failed' || phase === 'PartiallyFailed') {
      state = phase === 'Failed' ? 'critical' : 'warning';
      note = t('backups.note.lastFailed');
    } else if (schedule !== MANUAL && Number.isFinite(newestAge) && newestAge > maxAgeHours * H) {
      state = 'warning';
      note = t('backups.note.overdue', { hours: maxAgeHours });
    }
    const location = newest.spec?.storageLocation;
    rows.push({
      id: `velero/${schedule}`,
      kind: 'velero',
      name: schedule === MANUAL ? t('velero.manual') : raw(schedule),
      lastSuccess: lastOk ? new Date(completedAt(lastOk)).toISOString() : null,
      ageMs,
      state,
      ...(note ? { note } : {}),
      // A BackupStorageLocation names its provider; the agent does not read those, only the name.
      target: location ? { type: 'unknown', location } : null,
      count: own.length,
    });
  }
  return rows;
}

export function buildBackups(data: RunData, now: Date, maxAgeHours: number): BackupsView {
  const at = now.getTime();
  const cnpg = cnpgRows(data.cnpgClusters ?? [], at, maxAgeHours);
  const longhorn = longhornRows(data.longhornBackups ?? [], data.longhornBackupTargets ?? [], data.longhornVolumes ?? [], at, maxAgeHours);
  // An install without RKE2/k3s snapshots (or with the etcd check off) has no etcd row at all.
  const etcd = data.etcdSnapshots ? [etcdRow(data.etcdSnapshots, at, maxAgeHours)] : [];
  const order: Record<BackupKind, number> = { cnpg: 0, longhorn: 1, etcd: 2, velero: 3 };
  const rows = [...cnpg.rows, ...longhorn.rows, ...etcd, ...veleroRows(data.veleroBackups ?? [], at, maxAgeHours)].sort(
    (a, b) => RANK[a.state] - RANK[b.state] || order[a.kind] - order[b.kind] || a.id.localeCompare(b.id),
  );
  return {
    maxAgeHours,
    rows,
    targets: longhorn.targets,
    unprotected: [...cnpg.unprotected, ...longhorn.unprotected],
    ...(longhorn.orphaned.backups > 0 ? { orphaned: { kind: 'longhorn' as const, ...longhorn.orphaned } } : {}),
  };
}
