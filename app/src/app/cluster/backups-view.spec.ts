import { describe, expect, it } from 'vitest';

import { BackupRow, BackupsView } from '../core/agent.model';
import { translatorFor } from '../i18n/translator';
import { backupsView, targetText } from './backups-view';

const de = translatorFor('de');
const en = translatorFor('en');
const NOW = new Date('2026-11-24T12:00:00Z');
const ago = (h: number) => new Date(NOW.getTime() - h * 3_600_000).toISOString();

const row = (over: Partial<BackupRow>): BackupRow => ({
  id: `${over.kind}/${over.name}`,
  kind: 'cnpg',
  name: 'db',
  lastSuccess: ago(3),
  ageMs: 0,
  state: 'ok',
  target: { type: 's3', location: 's3://bucket/db' },
  count: null,
  ...over,
});

const view: BackupsView = {
  maxAgeHours: 26,
  rows: [
    row({
      kind: 'velero',
      name: 'daily-apps',
      state: 'warning',
      note: 'The last run failed',
      target: { type: 'unknown', location: 'default' },
      count: 3,
    }),
    row({
      kind: 'cnpg',
      name: 'shop-pg',
      namespace: 'default',
      lastSuccess: ago(31),
      state: 'warning',
      note: 'Older than 26 h',
    }),
    row({ kind: 'cnpg', name: 'api-pg', namespace: 'default' }),
    row({
      kind: 'etcd',
      name: 'etcd',
      lastSuccess: ago(5),
      count: 7,
      target: { type: 'local', location: '/var/lib/rancher' },
    }),
    row({
      kind: 'longhorn',
      name: 'data-0',
      namespace: 'web',
      lastSuccess: null,
      state: 'critical',
      note: 'No backup yet',
      count: 1,
    }),
  ],
  targets: [
    {
      kind: 'longhorn',
      name: 'default',
      type: 'nfs',
      location: 'nfs://nas:/backups',
      available: false,
    },
  ],
  unprotected: [
    { kind: 'longhorn', name: 'data-loki-0', namespace: 'monitoring' },
    { kind: 'cnpg', name: 'scratch-pg', namespace: 'dev' },
  ],
};

describe('backupsView', () => {
  it('groups by tool in a fixed order, the worst first in each', () => {
    const v = backupsView(view, NOW, de);
    expect(v.groups.map((g) => [g.product, g.what])).toEqual([
      ['CloudNativePG', 'Datenbanken'],
      ['Longhorn', 'Volumes'],
      ['etcd', 'Cluster-Zustand'],
      ['Velero', 'Zeitpläne'],
    ]);
    expect(v.groups[0].lines.map((l) => l.name)).toEqual(['shop-pg', 'api-pg']);
    expect(v.summary).toBe('3 von 5 brauchen Aufmerksamkeit.');
    expect(v.summaryTone).toBe('critical');
  });

  it('says when, where to and how many, from the time rather than the stale age', () => {
    const [cnpg, longhorn, etcd, velero] = backupsView(view, NOW, de).groups;
    expect(cnpg.lines[0]).toMatchObject({
      last: 'zuletzt vor 31 h',
      state: 'Achtung',
      note: 'Older than 26 h',
      target: 'S3, s3://bucket/db',
      count: null,
      namespace: 'default',
    });
    expect(cnpg.lines[1].note).toBeNull();
    expect(longhorn.lines[0]).toMatchObject({
      last: 'noch nie gesichert',
      state: 'Kritisch',
      count: '1 Backup vorhanden',
    });
    expect(etcd.lines[0]).toMatchObject({
      count: '7 Snapshots vorhanden',
      target: 'lokal, /var/lib/rancher',
    });
    expect(velero.lines[0].target).toBe('Speicherort default');
  });

  it('lists targets with availability and what has no backup at all', () => {
    const v = backupsView(view, NOW, en);
    expect(v.targets).toEqual([
      {
        name: 'default',
        tone: 'critical',
        text: 'NFS, nfs://nas:/backups',
        availability: 'Unreachable',
      },
    ]);
    expect(v.unprotected.map((u) => [u.kind, u.name])).toEqual([
      ['Volume', 'monitoring/data-loki-0'],
      ['Database', 'dev/scratch-pg'],
    ]);
    expect(v.groups[2].lines[0]).toMatchObject({ last: 'last 5 h ago', count: '7 snapshots kept' });
    expect(v.intro).toContain('Older than 26 h counts as overdue');
  });

  it('is empty only when nothing at all is known, and calm when all is fine', () => {
    expect(
      backupsView({ maxAgeHours: 26, rows: [], targets: [], unprotected: [] }, NOW, de),
    ).toMatchObject({ empty: true, summary: '' });
    expect(backupsView(null, NOW, de).empty).toBe(true);
    const calm = backupsView(
      { ...view, rows: [view.rows[2]], targets: [], unprotected: [] },
      NOW,
      en,
    );
    expect(calm).toMatchObject({
      empty: false,
      summary: 'The backup is up to date.',
      summaryTone: 'ok',
    });
  });

  it('names target kinds the way their products do', () => {
    expect(targetText({ type: 'azure', location: 'https://x.blob.core.windows.net/b' }, en)).toBe(
      'Azure Blob Storage, https://x.blob.core.windows.net/b',
    );
    expect(targetText({ type: 'unknown' }, en)).toBe('target unknown');
    expect(targetText(null, en)).toBeNull();
  });
});
