import { PendingSync } from '../core/agent.model';
import { relativeTime } from '../core/format';
import { Translator } from '../i18n/translator';

export interface PendingSyncRow {
  key: string;
  id: string;
  app: string;
  /** "nach weblate, Projekt default". */
  where: string;
  /** "seit dem letzten Sync vor 3 h": the change waits at most that long; when exactly it came, the Application does not say. */
  since: string;
  /** "4e6a8c0 → 9b1d0c3", or empty. */
  revisions: string;
  images: string[];
  resources: { key: string; text: string; change: 'update' | 'new' | 'prune'; label: string }[];
  canSync: boolean;
  syncConfirm: string;
}

const CHANGE: Record<'update' | 'new' | 'prune', 'pendingSync.update' | 'pendingSync.new' | 'pendingSync.prune'> = {
  update: 'pendingSync.update',
  new: 'pendingSync.new',
  prune: 'pendingSync.prune',
};

/** Repository paths shortened to the last part, so "agent:2026-11-25-11 → 2026-11-25-14" fits a phone. */
function imageChange(from: string, to: string): string {
  const name = (i: string) => i.slice(i.lastIndexOf('/') + 1);
  const tag = (i: string) => i.slice(i.lastIndexOf(':') + 1);
  return `${name(from)} → ${tag(to)}`;
}

/** The apps ready to sync, the longest waiting first. */
export function pendingSyncRows(list: PendingSync[], now: Date, tr: Translator): PendingSyncRow[] {
  return [...list]
    .sort((a, b) => (a.lastSyncAt ?? '').localeCompare(b.lastSyncAt ?? '') || a.app.localeCompare(b.app))
    .map((p) => ({
      key: `${p.namespace}/${p.app}`,
      id: p.id,
      app: p.app,
      where: [p.destination ? tr.t('pendingSync.into', { namespace: p.destination }) : null, p.project ? tr.t('pendingSync.project', { project: p.project }) : null].filter(Boolean).join(', '),
      since: p.lastSyncAt ? tr.t('pendingSync.since', { when: relativeTime(p.lastSyncAt, now, tr.lang) }) : tr.t('pendingSync.sinceUnknown'),
      revisions: p.syncedRevision && p.targetRevision ? `${p.syncedRevision} → ${p.targetRevision}` : (p.targetRevision ?? ''),
      images: p.images.map((i) => imageChange(i.from, i.to)),
      resources: p.resources.map((r) => ({ key: `${r.kind}/${r.namespace ?? ''}/${r.name}`, text: `${r.kind} ${r.name}`, change: r.change, label: tr.t(CHANGE[r.change]) })),
      canSync: p.canSync,
      syncConfirm: tr.t('actions.syncConfirm', { app: p.app }),
    }));
}
