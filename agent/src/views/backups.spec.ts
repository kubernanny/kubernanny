import { describe, expect, it } from 'vitest';
import { de } from '../testing/i18n';
import { RunData } from '../modules/types';
import { ageState, buildBackups, targetFromUrl } from './backups';

const NOW = new Date('2026-11-24T12:00:00Z');
const H = 3_600_000;
const ago = (hours: number) => new Date(NOW.getTime() - hours * H).toISOString();

describe('backups view', () => {
  it('reads the storage from the URL and never keeps a query string', () => {
    expect(targetFromUrl('s3://bucket@eu-central-2/longhorn')).toEqual({ type: 's3', location: 's3://bucket@eu-central-2/longhorn' });
    expect(targetFromUrl('nfs://nas:/export/backups?nfsOptions=soft')).toEqual({ type: 'nfs', location: 'nfs://nas:/export/backups' });
    expect(targetFromUrl('https://acct.blob.core.windows.net/pg')?.type).toBe('azure');
    expect(targetFromUrl('gs://bucket/pg')?.type).toBe('gcs');
    expect(targetFromUrl('cifs://nas/share')?.type).toBe('cifs');
    expect(targetFromUrl('file:///var/backups')?.type).toBe('local');
    expect(targetFromUrl('weird')?.type).toBe('unknown');
    expect(targetFromUrl(undefined)).toBeNull();
  });

  it('applies the checks age rule: over the limit a warning, twice over critical', () => {
    expect([ageState(10 * H, 26, 'warning'), ageState(30 * H, 26, 'warning'), ageState(60 * H, 26, 'warning'), ageState(null, 26, 'critical')]).toEqual(['ok', 'warning', 'critical', 'critical']);
  });

  it('builds one row per protected thing, worst first, with the same verdicts as the checks', () => {
    const data: RunData = {
      cnpgClusters: [
        { metadata: { name: 'ok-pg', namespace: 'a' }, spec: { backup: { barmanObjectStore: { destinationPath: 's3://b/pg' } } }, status: { lastSuccessfulBackup: ago(5) } },
        { metadata: { name: 'wal-pg', namespace: 'a' }, spec: { backup: { barmanObjectStore: {} } }, status: { lastSuccessfulBackup: ago(5), conditions: [{ type: 'ContinuousArchiving', status: 'False' }] } },
        { metadata: { name: 'never-pg', namespace: 'b' }, spec: { plugins: [{ name: 'barman-cloud.cloudnative-pg.io' }] }, status: {} },
        { metadata: { name: 'bare-pg', namespace: 'b' }, spec: {}, status: {} },
      ],
      longhornVolumes: [
        { metadata: { name: 'pvc-1' }, status: { state: 'attached', kubernetesStatus: { namespace: 'web', pvcName: 'data-web-0' } } },
        { metadata: { name: 'pvc-2' }, status: { state: 'attached', kubernetesStatus: { namespace: 'mon', pvcName: 'data-prom-0' } } },
        { metadata: { name: 'pvc-3' }, status: { state: 'detached' } },
      ],
      longhornBackups: [
        { metadata: { name: 'x1' }, status: { state: 'Completed', volumeName: 'pvc-1', backupCreatedAt: ago(30) } },
        { metadata: { name: 'x2' }, status: { state: 'Error', volumeName: 'pvc-1', backupCreatedAt: ago(4), error: 'boom' } },
      ],
      longhornBackupTargets: [{ metadata: { name: 'default' }, spec: { backupTargetURL: 'nfs://nas:/lh?nfsOptions=soft' }, status: { available: true } }],
      etcdSnapshots: [
        { metadata: { name: 's1' }, spec: { nodeName: 'n1', location: 'file:///snap' }, status: { creationTime: ago(3), readyToUse: true } },
        { metadata: { name: 's2' }, spec: { s3: {}, location: 's3://b/etcd' }, status: { creationTime: ago(15), readyToUse: true } },
      ],
      veleroBackups: [
        { metadata: { name: 'd-1', labels: { 'velero.io/schedule-name': 'daily' }, creationTimestamp: ago(28) }, spec: { storageLocation: 'default' }, status: { phase: 'Completed', completionTimestamp: ago(28) } },
        { metadata: { name: 'd-2', labels: { 'velero.io/schedule-name': 'daily' }, creationTimestamp: ago(4) }, spec: { storageLocation: 'default' }, status: { phase: 'Failed', completionTimestamp: ago(4) } },
        { metadata: { name: 'by-hand', creationTimestamp: ago(200) }, status: { phase: 'Completed', completionTimestamp: ago(200) } },
      ],
    };
    const view = de(buildBackups(data, NOW, 26));
    expect(view.rows.map((r) => [r.id, r.state, r.note ?? null])).toEqual([
      ['cnpg/a/wal-pg', 'critical', 'WAL-Archivierung schlägt fehl'],
      ['velero/daily', 'critical', 'Der letzte Lauf ist fehlgeschlagen'],
      ['cnpg/b/never-pg', 'warning', 'Noch kein erfolgreiches Backup'],
      ['longhorn/pvc-1', 'warning', 'Der letzte Lauf ist fehlgeschlagen'],
      ['cnpg/a/ok-pg', 'ok', null],
      ['etcd', 'ok', null],
      ['velero/(manuell)', 'ok', null],
    ]);
    expect(view.rows.find((r) => r.id === 'longhorn/pvc-1')).toMatchObject({ name: 'data-web-0', namespace: 'web', count: 2, lastSuccess: ago(30), target: { type: 'nfs', location: 'nfs://nas:/lh' } });
    expect(view.rows.find((r) => r.id === 'cnpg/a/ok-pg')).toMatchObject({ target: { type: 's3', location: 's3://b/pg' }, ageMs: 5 * H, count: null });
    expect(view.rows.find((r) => r.id === 'cnpg/b/never-pg')?.target).toEqual({ type: 'unknown' });
    expect(view.rows.find((r) => r.id === 'etcd')).toMatchObject({ lastSuccess: ago(3), count: 2, target: { type: 'local', location: 'n1' } });
    expect(view.rows.find((r) => r.id === 'velero/daily')).toMatchObject({ lastSuccess: ago(28), count: 2, target: { type: 'unknown', location: 'default' } });
    expect(view.rows.find((r) => r.id === 'velero/(manuell)')?.name).toBe('(manuell)');
    expect(view.targets).toEqual([{ kind: 'longhorn', name: 'default', type: 'nfs', location: 'nfs://nas:/lh', available: true }]);
    expect(view.unprotected).toEqual([
      { kind: 'cnpg', name: 'bare-pg', namespace: 'b' },
      { kind: 'longhorn', name: 'data-prom-0', namespace: 'mon' },
    ]);
  });

  it('makes every volume critical while the backup target is unreachable, as the check does', () => {
    const view = buildBackups(
      {
        longhornBackups: [{ metadata: { name: 'x' }, status: { state: 'Completed', volumeName: 'v', backupCreatedAt: ago(2) } }],
        longhornBackupTargets: [{ metadata: { name: 'default' }, spec: { backupTargetURL: 's3://b@r/' }, status: { available: false } }],
      },
      NOW,
      26,
    );
    expect(de(view.rows)).toMatchObject([{ id: 'longhorn/v', name: 'v', state: 'critical', note: 'Backup-Ziel nicht erreichbar' }]);
  });

  it('has no etcd row without snapshot data, and calls an empty snapshot list a warning', () => {
    expect(buildBackups({}, NOW, 26)).toEqual({ maxAgeHours: 26, rows: [], targets: [], unprotected: [] });
    expect(buildBackups({ etcdSnapshots: [] }, NOW, 26).rows).toMatchObject([{ id: 'etcd', state: 'warning', lastSuccess: null, count: 0 }]);
  });
});
