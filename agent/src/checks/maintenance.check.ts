import { raw, rawOr, t } from '../i18n/text';
import { ageText, Condition, condition, Issue, IssueAction, ObjectMeta } from './types';

// ---------- PodDisruptionBudgets ----------

export interface Pdb {
  metadata: ObjectMeta;
  spec?: {
    minAvailable?: number | string;
    maxUnavailable?: number | string;
    selector?: { matchLabels?: Record<string, string> };
  };
  status?: { disruptionsAllowed?: number; currentHealthy?: number; desiredHealthy?: number; expectedPods?: number };
}

const cnpgOwner = (pdb: Pdb) =>
  pdb.metadata.ownerReferences?.find(
    (o) => o.kind === 'Cluster' && (o.apiVersion ?? '').startsWith('postgresql.cnpg.io/'),
  );

/**
 * PDBs an operator creates to steer drains itself, and that therefore never
 * hold a drain up for good:
 *
 * - CloudNativePG's `<cluster>-primary` (minAvailable 1 on the primary). When
 *   the primary's node is cordoned, the operator switches the primary over to
 *   a replica, after which the old primary is an ordinary replica and can be
 *   evicted (CNPG docs, "Kubernetes upgrade and maintenance"). That needs a
 *   replica: CNPG then also creates the `<cluster>` PDB for the replicas, so a
 *   sibling PDB of the same Cluster with pods is the sign. A one-instance
 *   cluster with enablePDB has no replica to switch to and really blocks.
 * - Longhorn's per-node `instance-manager-*` PDBs, created and removed by
 *   longhorn-manager according to its node-drain-policy (e.g.
 *   block-for-eviction-if-contains-last-replica): Longhorn first moves the
 *   replicas off the node and then deletes the PDB. Blocking until then is the
 *   point; Longhorn's own volume checks report a replica that cannot move.
 */
function managedByDrainAwareOperator(pdb: Pdb, all: Pdb[]): boolean {
  const labels = pdb.spec?.selector?.matchLabels ?? {};
  if (
    labels['longhorn.io/component'] === 'instance-manager' &&
    labels['longhorn.io/managed-by'] === 'longhorn-manager'
  ) {
    return true;
  }
  const owner = cnpgOwner(pdb);
  if (owner && pdb.metadata.name.endsWith('-primary')) {
    const sameCluster = (o: Pdb) =>
      o !== pdb &&
      o.metadata.namespace === pdb.metadata.namespace &&
      cnpgOwner(o)?.name === owner.name &&
      (owner.uid === undefined || cnpgOwner(o)?.uid === owner.uid);
    return all.some((o) => sameCluster(o) && (o.status?.expectedPods ?? 0) > 0);
  }
  return false;
}

/**
 * A PDB that allows no disruption while all its pods are healthy blocks every
 * node drain: kured's nightly reboot, a system upgrade, a cordon by hand. The
 * drain waits until it gives up (kured: --drain-timeout, after which the node
 * is uncordoned and not rebooted; kubectl drain without a timeout: forever).
 * (When pods are unhealthy the Workloads check already reports them.)
 */
export function evaluatePdbs(pdbs: Pdb[]): Issue[] {
  const issues: Issue[] = [];
  for (const pdb of pdbs) {
    const s = pdb.status;
    const expected = s?.expectedPods ?? 0;
    if (expected === 0 || (s?.disruptionsAllowed ?? 0) > 0) {
      continue;
    }
    const healthy = s?.currentHealthy ?? 0;
    if (healthy < (s?.desiredHealthy ?? 0)) {
      continue;
    }
    if (managedByDrainAwareOperator(pdb, pdbs)) {
      continue;
    }
    const ns = pdb.metadata.namespace ?? 'default';
    const rule =
      pdb.spec?.minAvailable !== undefined
        ? `minAvailable: ${pdb.spec.minAvailable}`
        : `maxUnavailable: ${pdb.spec?.maxUnavailable}`;
    const cnpg = cnpgOwner(pdb);
    issues.push({
      id: `pdb/${ns}/${pdb.metadata.name}`,
      check: 'pdb',
      severity: 'warning',
      title: t('pdb.title', { pdb: `${ns}/${pdb.metadata.name}` }),
      cause: cnpg ? t('pdb.cause.cnpgSingle', { cluster: cnpg.name }) : t('pdb.cause', { rule, pods: expected }),
      actions: [],
    });
  }
  return issues;
}

// ---------- HorizontalPodAutoscalers ----------

export interface Hpa {
  metadata: ObjectMeta;
  spec?: { minReplicas?: number; maxReplicas?: number; scaleTargetRef?: { kind?: string; name?: string } };
  status?: { currentReplicas?: number; desiredReplicas?: number; conditions?: Condition[] };
}

export function evaluateHpas(hpas: Hpa[]): Issue[] {
  const issues: Issue[] = [];
  for (const hpa of hpas) {
    const ns = hpa.metadata.namespace ?? 'default';
    const id = `hpa/${ns}/${hpa.metadata.name}`;
    const target = hpa.spec?.scaleTargetRef?.name ?? hpa.metadata.name;
    const active = condition(hpa.status?.conditions, 'ScalingActive');
    const able = condition(hpa.status?.conditions, 'AbleToScale');
    const limited = condition(hpa.status?.conditions, 'ScalingLimited');
    if (active?.status === 'False') {
      issues.push({
        id,
        check: 'hpa',
        severity: 'warning',
        title: t('hpa.noMetrics.title', { target: `${ns}/${target}` }),
        cause: t('hpa.noMetrics.cause', { message: active.message ?? active.reason ?? 'ScalingActive=False' }),
        actions: [],
      });
    } else if (able?.status === 'False') {
      issues.push({
        id,
        check: 'hpa',
        severity: 'warning',
        title: t('hpa.cannotScale.title', { target: `${ns}/${target}` }),
        cause: raw(able.message ?? able.reason ?? 'AbleToScale=False'),
        actions: [],
      });
    } else if (
      limited?.status === 'True' &&
      limited.reason === 'TooManyReplicas' &&
      (hpa.status?.currentReplicas ?? 0) >= (hpa.spec?.maxReplicas ?? Infinity)
    ) {
      issues.push({
        id,
        check: 'hpa',
        severity: 'warning',
        title: t('hpa.atMax.title', { target: `${ns}/${target}`, max: String(hpa.spec?.maxReplicas) }),
        cause: t('hpa.atMax.cause', {
          desired: hpa.status?.desiredReplicas !== undefined ? String(hpa.status.desiredReplicas) : undefined,
        }),
        actions: [],
      });
    }
  }
  return issues;
}

// ---------- etcd snapshots (RKE2, k3s) ----------

export interface EtcdSnapshot {
  metadata: ObjectMeta;
  spec?: { snapshotName?: string; nodeName?: string; location?: string; s3?: unknown };
  status?: { creationTime?: string; readyToUse?: boolean; size?: string; error?: { message?: string; time?: string } };
}

/** RKE2 and k3s take etcd snapshots on a schedule (default every 12 h) and record each as an ETCDSnapshotFile. */
export function evaluateEtcdSnapshots(snapshots: EtcdSnapshot[], now: Date, maxAgeHours: number): Issue[] {
  if (snapshots.length === 0) {
    return [
      {
        id: 'etcd/snapshots',
        check: 'etcd',
        severity: 'warning',
        title: t('etcdSnapshots.none.title'),
        cause: t('etcdSnapshots.none.cause'),
        actions: [],
      },
    ];
  }
  const time = (s: EtcdSnapshot) => Date.parse(s.status?.creationTime ?? s.metadata.creationTimestamp ?? '');
  const sorted = [...snapshots].sort((a, b) => time(b) - time(a));
  const lastGood = sorted.find((s) => s.status?.readyToUse !== false && !s.status?.error);
  const newest = sorted[0];
  const issues: Issue[] = [];
  if (newest.status?.error) {
    issues.push({
      id: 'etcd/snapshot-failed',
      check: 'etcd',
      severity: 'warning',
      title: t('etcdSnapshots.failed.title'),
      cause: t('etcdSnapshots.failed.cause', {
        node: newest.spec?.nodeName,
        location: newest.spec?.s3 ? raw('(S3)') : t('etcdSnapshots.local'),
        message: newest.status.error.message,
      }),
      actions: [],
    });
  }
  const age = lastGood ? now.getTime() - time(lastGood) : Infinity;
  if (age > maxAgeHours * 3_600_000) {
    issues.push({
      id: 'etcd/snapshot-age',
      check: 'etcd',
      severity: age > 2 * maxAgeHours * 3_600_000 ? 'critical' : 'warning',
      title: lastGood ? t('etcdSnapshots.age.title', { age: ageText(age) }) : t('etcdSnapshots.noValid.title'),
      cause: t('etcdSnapshots.age.cause'),
      actions: [],
    });
  }
  return issues;
}

// ---------- API server certificate ----------

export function evaluateApiServerCertificate(notAfter: Date | null, now: Date): Issue[] {
  if (!notAfter) {
    return [];
  }
  const left = notAfter.getTime() - now.getTime();
  if (left > 30 * 86_400_000) {
    return [];
  }
  return [
    {
      id: 'apiserver/certificate',
      check: 'apiserver',
      severity: left < 7 * 86_400_000 ? 'critical' : 'warning',
      title: left <= 0 ? t('apiserver.cert.expired') : t('apiserver.cert.expiring', { age: ageText(left) }),
      cause: t('apiserver.cert.cause'),
      actions: [],
    },
  ];
}

// ---------- Longhorn backups ----------

export interface LonghornBackup {
  metadata: ObjectMeta;
  status?: {
    state?: string;
    volumeName?: string;
    backupCreatedAt?: string;
    snapshotCreatedAt?: string;
    error?: string;
    messages?: Record<string, string>;
  };
}

export interface LonghornBackupTarget {
  metadata: ObjectMeta;
  spec?: { backupTargetURL?: string };
  status?: { available?: boolean; conditions?: { type: string; status: string; message?: string }[] };
}

/** A Longhorn volume as the backup checks see it: name, attachment, the PVC it serves. */
export interface LonghornBackupVolume {
  metadata: ObjectMeta;
  status?: { state?: string; kubernetesStatus?: { namespace?: string; pvcName?: string } };
}

/** `namespace/pvc` for a volume a PVC uses, else the Longhorn volume name (pvc-<uuid>). */
function longhornVolumeLabel(v: LonghornBackupVolume): string {
  const k8s = v.status?.kubernetesStatus;
  return k8s?.pvcName ? `${k8s.namespace ?? 'default'}/${k8s.pvcName}` : v.metadata.name;
}

export interface LonghornBackupGroups {
  /** Backups of every volume that exists now, by volume name (volumes without a backup are absent). */
  byVolume: Map<string, LonghornBackup[]>;
  /** Backups the target still holds for volumes that were deleted. */
  orphaned: { volumes: number; backups: number };
}

/**
 * Longhorn keeps every backup in the target after its volume is deleted (a
 * BackupVolume per deleted volume, until someone removes it). Those are no
 * longer protecting anything, so only volumes that exist now are judged.
 */
export function groupLonghornBackups(volumes: LonghornBackupVolume[], backups: LonghornBackup[]): LonghornBackupGroups {
  const existing = new Set(volumes.map((v) => v.metadata.name));
  const byVolume = new Map<string, LonghornBackup[]>();
  const orphanVolumes = new Set<string>();
  let orphanBackups = 0;
  for (const b of backups) {
    const v = b.status?.volumeName;
    if (!v) {
      continue;
    }
    if (existing.has(v)) {
      byVolume.set(v, [...(byVolume.get(v) ?? []), b]);
    } else {
      orphanVolumes.add(v);
      orphanBackups++;
    }
  }
  return { byVolume, orphaned: { volumes: orphanVolumes.size, backups: orphanBackups } };
}

export const longhornBackupTime = (b: LonghornBackup) =>
  Date.parse(b.status?.backupCreatedAt || b.status?.snapshotCreatedAt || b.metadata.creationTimestamp || '');

export function evaluateLonghornBackups(
  targets: LonghornBackupTarget[],
  backups: LonghornBackup[],
  volumes: LonghornBackupVolume[],
  now: Date,
  maxAgeHours: number,
): Issue[] {
  const issues: Issue[] = [];
  for (const target of targets) {
    if (target.spec?.backupTargetURL && target.status?.available === false) {
      const reason = target.status.conditions?.find((c) => c.type === 'Unavailable' && c.status === 'True')?.message;
      issues.push({
        id: `longhorn/backup-target/${target.metadata.name}`,
        check: 'longhorn',
        severity: 'critical',
        title: t('longhorn.backupTarget.title'),
        cause: t('longhorn.backupTarget.cause', { url: target.spec.backupTargetURL, reason }),
        actions: [],
      });
    }
  }
  const { byVolume } = groupLonghornBackups(volumes, backups);
  const time = longhornBackupTime;
  for (const volume of volumes) {
    const list = byVolume.get(volume.metadata.name);
    if (!list) {
      // Not every volume needs a backup; the Backups view lists these as unprotected.
      continue;
    }
    const name = volume.metadata.name;
    const label = longhornVolumeLabel(volume);
    // Longhorn's recurring jobs skip a detached volume (unless the setting
    // allow-recurring-job-while-volume-detached is on), so its backups age by
    // design: nothing writes to it either. Worth knowing, not a fault.
    const detached = volume.status?.state === 'detached';
    // A snapshot (and so a backup) needs the volume attached.
    const backupNow: IssueAction[] =
      volume.status?.state === 'attached'
        ? [{ type: 'longhorn-backup', namespace: volume.metadata.namespace ?? 'longhorn-system', volume: name, label }]
        : [];
    const sorted = list.filter((b) => Number.isFinite(time(b))).sort((a, b) => time(b) - time(a));
    const lastOk = sorted.find((b) => b.status?.state === 'Completed');
    const newest = sorted[0];
    if (newest?.status?.state === 'Error') {
      issues.push({
        id: `longhorn/backup/${name}`,
        check: 'longhorn',
        severity: 'warning',
        title: t('longhorn.backup.failed.title', { volume: label }),
        cause: rawOr(
          newest.status.error || Object.values(newest.status.messages ?? {})[0],
          t('longhorn.backup.failed.cause'),
        ),
        actions: backupNow,
      });
      continue;
    }
    const age = lastOk ? now.getTime() - time(lastOk) : Infinity;
    if (age > maxAgeHours * 3_600_000) {
      issues.push({
        id: `longhorn/backup/${name}`,
        check: 'longhorn',
        severity: detached ? 'info' : age > 2 * maxAgeHours * 3_600_000 ? 'critical' : 'warning',
        title: lastOk
          ? t('longhorn.backup.old.title', { volume: label, age: ageText(age) })
          : t('longhorn.backup.none.title', { volume: label }),
        cause: detached ? t('longhorn.backup.detached.cause') : t('longhorn.backup.old.cause'),
        actions: backupNow,
      });
    }
  }
  return issues;
}
