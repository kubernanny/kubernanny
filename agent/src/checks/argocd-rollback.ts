import type { ArgoApplication } from './argocd.check';

/**
 * Rolling a manual-sync Argo CD app back to a state it was deployed in
 * before (`argocd-rollback`, opt-in). Pure judgement, used by the module
 * view (what to offer) and by the route (what to refuse), so both say the
 * same.
 *
 * Everything here reads the Application, and an Application's `status` is
 * writable by whoever can edit it. So a history entry is only a candidate
 * when its revision looks like what Argo CD writes there (a commit SHA for
 * Git, a chart version for Helm) and its source is the app's own
 * `spec.source`: the rollback then only moves that source to an earlier
 * revision, never to another repository.
 */

export interface ArgoSource {
  repoURL?: string;
  path?: string;
  chart?: string;
  targetRevision?: string;
}

export interface ArgoHistoryEntry {
  id?: number;
  revision?: string;
  deployedAt?: string;
  source?: ArgoSource;
  sources?: ArgoSource[];
}

/** A Git commit as Argo CD records it in `status.history`: the full SHA-1. */
const GIT_SHA = /^[0-9a-f]{40}$/;
/** A Helm chart version (SemVer, optional leading v), short. */
const CHART_VERSION = /^v?\d{1,6}\.\d{1,6}\.\d{1,6}(?:-[0-9A-Za-z.-]{1,40})?(?:\+[0-9A-Za-z.-]{1,40})?$/;
/** Argo CD keeps 10 entries by default (`revisionHistoryLimit`); more are never listed. */
const MAX_ENTRIES = 10;
const MAX_APPS = 50;

export type RollbackRefusal =
  | 'ROLLBACK_AUTOMATED'
  | 'ROLLBACK_MULTI_SOURCE'
  | 'ROLLBACK_NO_SOURCE'
  | 'ROLLBACK_RUNNING'
  | 'ROLLBACK_HISTORY_NOT_FOUND'
  | 'ROLLBACK_REVISION'
  | 'ROLLBACK_CURRENT'
  | 'ROLLBACK_OTHER_SOURCE';

export interface RollbackEntry {
  id: number;
  revision: string;
  /** Seven characters of a SHA, a chart version as it is. */
  short: string;
  deployedAt?: string;
  current: boolean;
}

export interface RollbackApp {
  namespace: string;
  app: string;
  /** The revision deployed now (`status.sync.revision`), short; absent when Argo CD reports none. */
  current?: string;
  /** Newest first; the current one is listed with `current: true` and cannot be chosen. */
  entries: RollbackEntry[];
}

function plausibleRevision(revision: unknown, source: ArgoSource): revision is string {
  return typeof revision === 'string' && (source.chart ? CHART_VERSION : GIT_SHA).test(revision);
}

export function shortRevision(revision: string): string {
  return GIT_SHA.test(revision) ? revision.slice(0, 7) : revision;
}

/** Same repository and the same path or chart; the target revision may differ (that is the point). */
function sameSource(a: ArgoSource | undefined, b: ArgoSource): boolean {
  return a !== undefined && typeof a.repoURL === 'string' && a.repoURL === b.repoURL && (a.path ?? '') === (b.path ?? '') && (a.chart ?? '') === (b.chart ?? '');
}

/** Why the app as a whole cannot be rolled back by Kubernanny, or null. */
function appRefusal(app: ArgoApplication): RollbackRefusal | null {
  // Argo CD itself refuses a rollback with auto-sync on: it would sync straight back to Git.
  if (app.spec?.syncPolicy?.automated !== undefined && app.spec.syncPolicy.automated !== null) {
    return 'ROLLBACK_AUTOMATED';
  }
  if (app.spec?.sources !== undefined) {
    return 'ROLLBACK_MULTI_SOURCE';
  }
  if (!app.spec?.source || typeof app.spec.source.repoURL !== 'string') {
    return 'ROLLBACK_NO_SOURCE';
  }
  if (app.operation !== undefined || app.status?.operationState?.phase === 'Running') {
    return 'ROLLBACK_RUNNING';
  }
  return null;
}

/** Why this history entry is no rollback target, or null; `id` comes from the request. */
function entryRefusal(app: ArgoApplication, entry: ArgoHistoryEntry | undefined): RollbackRefusal | null {
  const source = app.spec!.source!;
  if (!entry) {
    return 'ROLLBACK_HISTORY_NOT_FOUND';
  }
  if (entry.sources !== undefined || !sameSource(entry.source, source)) {
    return 'ROLLBACK_OTHER_SOURCE';
  }
  if (!plausibleRevision(entry.revision, source)) {
    return 'ROLLBACK_REVISION';
  }
  if (entry.revision === app.status?.sync?.revision) {
    return 'ROLLBACK_CURRENT';
  }
  return null;
}

/** The history entry the route rolls back to, or why not. */
export function rollbackTarget(app: ArgoApplication, id: number): { revision: string; entry: ArgoHistoryEntry } | { refusal: RollbackRefusal } {
  const refusal = appRefusal(app);
  if (refusal) {
    return { refusal };
  }
  const entry = (app.status?.history ?? []).find((h) => h.id === id);
  const entryProblem = entryRefusal(app, entry);
  return entryProblem ? { refusal: entryProblem } : { revision: entry!.revision!, entry: entry! };
}

/**
 * What the Argo CD sheet lists while the action is on: every manual-sync,
 * single-source app with at least one earlier deployment to go back to,
 * and its last entries (only those of its own source with a plausible
 * revision).
 */
export function rollbackApps(apps: ArgoApplication[]): RollbackApp[] {
  const out: RollbackApp[] = [];
  for (const app of apps) {
    if (appRefusal(app) && appRefusal(app) !== 'ROLLBACK_RUNNING') {
      continue;
    }
    const source = app.spec!.source!;
    const currentRevision = app.status?.sync?.revision;
    const entries = (app.status?.history ?? [])
      .filter((h): h is ArgoHistoryEntry & { id: number; revision: string } => Number.isSafeInteger(h.id) && h.sources === undefined && sameSource(h.source, source) && plausibleRevision(h.revision, source))
      .sort((a, b) => b.id - a.id)
      .slice(0, MAX_ENTRIES)
      .map((h) => ({ id: h.id, revision: h.revision, short: shortRevision(h.revision), ...(typeof h.deployedAt === 'string' ? { deployedAt: h.deployedAt } : {}), current: h.revision === currentRevision }));
    if (!entries.some((e) => !e.current)) {
      continue;
    }
    out.push({
      namespace: app.metadata.namespace ?? 'argocd',
      app: app.metadata.name,
      ...(typeof currentRevision === 'string' && plausibleRevision(currentRevision, source) ? { current: shortRevision(currentRevision) } : {}),
      entries,
    });
  }
  return out.sort((a, b) => a.app.localeCompare(b.app, 'en') || a.namespace.localeCompare(b.namespace, 'en')).slice(0, MAX_APPS);
}
