import { raw, rawOr, t } from '../i18n/text';
import { Condition, Issue, ObjectMeta, ageText, condition } from './types';

// ---------- PodDisruptionBudgets ----------

export interface Pdb {
  metadata: ObjectMeta;
  spec?: { minAvailable?: number | string; maxUnavailable?: number | string };
  status?: { disruptionsAllowed?: number; currentHealthy?: number; desiredHealthy?: number; expectedPods?: number };
}

/**
 * A PDB that allows no disruption while all its pods are healthy blocks every
 * node drain: kured's nightly reboot, a system upgrade, a cordon by hand. The
 * drain waits forever and the node never reboots. (When pods are unhealthy
 * the Workloads check already reports them.)
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
    const ns = pdb.metadata.namespace ?? 'default';
    const rule = pdb.spec?.minAvailable !== undefined ? `minAvailable: ${pdb.spec.minAvailable}` : `maxUnavailable: ${pdb.spec?.maxUnavailable}`;
    issues.push({
      id: `pdb/${ns}/${pdb.metadata.name}`,
      check: 'pdb',
      severity: 'warning',
      title: t('pdb.title', { pdb: `${ns}/${pdb.metadata.name}` }),
      cause: t('pdb.cause', { rule, pods: expected }),
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
        cause: t('hpa.atMax.cause', { desired: hpa.status?.desiredReplicas !== undefined ? String(hpa.status.desiredReplicas) : undefined }),
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
      cause: t('etcdSnapshots.failed.cause', { node: newest.spec?.nodeName, location: newest.spec?.s3 ? raw('(S3)') : t('etcdSnapshots.local'), message: newest.status.error.message }),
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
  status?: { state?: string; volumeName?: string; backupCreatedAt?: string; snapshotCreatedAt?: string; error?: string; messages?: Record<string, string> };
}

export interface LonghornBackupTarget {
  metadata: ObjectMeta;
  spec?: { backupTargetURL?: string };
  status?: { available?: boolean; conditions?: { type: string; status: string; message?: string }[] };
}

export function evaluateLonghornBackups(targets: LonghornBackupTarget[], backups: LonghornBackup[], now: Date, maxAgeHours: number): Issue[] {
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
  const byVolume = new Map<string, LonghornBackup[]>();
  for (const b of backups) {
    const v = b.status?.volumeName;
    if (v) {
      byVolume.set(v, [...(byVolume.get(v) ?? []), b]);
    }
  }
  const time = (b: LonghornBackup) => Date.parse(b.status?.backupCreatedAt || b.status?.snapshotCreatedAt || b.metadata.creationTimestamp || '');
  for (const [volume, list] of byVolume) {
    const sorted = list.filter((b) => Number.isFinite(time(b))).sort((a, b) => time(b) - time(a));
    const lastOk = sorted.find((b) => b.status?.state === 'Completed');
    const newest = sorted[0];
    if (newest?.status?.state === 'Error') {
      issues.push({
        id: `longhorn/backup/${volume}`,
        check: 'longhorn',
        severity: 'warning',
        title: t('longhorn.backup.failed.title', { volume }),
        cause: rawOr(newest.status.error || Object.values(newest.status.messages ?? {})[0], t('longhorn.backup.failed.cause')),
        actions: [],
      });
      continue;
    }
    const age = lastOk ? now.getTime() - time(lastOk) : Infinity;
    if (age > maxAgeHours * 3_600_000) {
      issues.push({
        id: `longhorn/backup/${volume}`,
        check: 'longhorn',
        severity: age > 2 * maxAgeHours * 3_600_000 ? 'critical' : 'warning',
        title: lastOk ? t('longhorn.backup.old.title', { volume, age: ageText(age) }) : t('longhorn.backup.none.title', { volume }),
        cause: t('longhorn.backup.old.cause'),
        actions: [],
      });
    }
  }
  return issues;
}
