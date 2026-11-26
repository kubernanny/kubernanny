/**
 * Manual Argo CD apps with a change waiting: OutOfSync, otherwise healthy,
 * their last sync succeeded. That is routine ("updates waiting"), not a
 * problem, so it is listed as "Bereit zum Sync" instead of as an issue
 * (docs/CHECKS.md). Everything here comes from the Application resource
 * itself; the agent has no Argo CD API token, so there are no commit
 * messages and no exact "OutOfSync since".
 */
import type { ArgoApplication } from './argocd.check';
import type { ArgoSource } from './argocd-rollback';
import { syncOffer } from './argocd-sync-offer';
import type { SyncOffer } from './types';

/** A manual app OutOfSync this long without a sync becomes a hint (only then; before, it is routine). */
export const PENDING_HINT_DAYS = 7;

export interface PendingSyncResource {
  kind: string;
  name: string;
  namespace?: string;
  /** update: differs from Git; new: in Git, not in the cluster; prune: in the cluster, no longer in Git. */
  change: 'update' | 'new' | 'prune';
}

export interface PendingSync {
  /** The id the sync action is run under, like the issue it used to be (`argocd/<ns>/<app>/sync`). */
  id: string;
  namespace: string;
  app: string;
  project?: string;
  /** Where it deploys to. */
  destination?: string;
  /** When the last sync finished: the change waits at most since then. */
  lastSyncAt?: string;
  /** The revision deployed now and the one Git has, short. */
  syncedRevision?: string;
  targetRevision?: string;
  resources: PendingSyncResource[];
  /** Images the sync would change, where Git names them (Helm image parameters, Kustomize images) and the app reports what runs. */
  images: { from: string; to: string }[];
  /** Whether the agent offers the sync (the opt-in argocd-sync action is on). */
  canSync: boolean;
  /** What the sync may do beyond a plain one: prune what `resources` marks `prune`, only with `argocd-sync-prune` on. */
  offer: SyncOffer;
}

interface ArgoAppFull extends ArgoApplication {
  spec?: ArgoApplication['spec'] & {
    project?: string;
    destination?: { namespace?: string; server?: string; name?: string };
  };
  status?: ArgoApplication['status'] & {
    operationState?: { phase?: string; finishedAt?: string; syncResult?: { revision?: string } };
    summary?: { images?: string[] };
    resources?: {
      kind: string;
      name: string;
      namespace?: string;
      status?: string;
      requiresPruning?: boolean;
      health?: { status?: string };
    }[];
  };
}

interface SourceWithOverrides extends ArgoSource {
  helm?: { parameters?: { name: string; value?: string }[] };
  kustomize?: { images?: string[] };
}

const short = (rev: string | undefined) => (rev && /^[0-9a-f]{40}$/.test(rev) ? rev.slice(0, 7) : rev || undefined);

/** "ghcr.io/x/y:tag" into repository and tag (a port in the registry is not a tag). */
function splitImage(image: string): { repo: string; tag: string } | null {
  const at = image.lastIndexOf(':');
  if (at <= image.lastIndexOf('/')) {
    return null;
  }
  return { repo: image.slice(0, at), tag: image.slice(at + 1) };
}

/** Images Git asks for: Helm `image.repository|name` + `image.tag` parameters (any prefix), Kustomize `images` overrides. */
function desiredImages(app: ArgoApplication): string[] {
  const sources = [app.spec?.source, ...(app.spec?.sources ?? [])].filter(
    (s): s is SourceWithOverrides => s !== undefined,
  );
  const out: string[] = [];
  for (const s of sources) {
    const params = new Map((s.helm?.parameters ?? []).map((p) => [p.name, p.value ?? '']));
    for (const [name, tag] of params) {
      if (!name.endsWith('.tag') && name !== 'tag') {
        continue;
      }
      const prefix = name.slice(0, -'tag'.length);
      const repo = params.get(`${prefix}repository`) ?? params.get(`${prefix}name`);
      if (repo && tag) {
        out.push(`${repo}:${tag}`);
      }
    }
    for (const k of s.kustomize?.images ?? []) {
      // "name=newName:tag" or "name:tag"
      out.push(k.includes('=') ? k.slice(k.indexOf('=') + 1) : k);
    }
  }
  return out;
}

/** The image changes a sync would roll out: a desired image whose repository runs with another tag. */
export function imageChanges(app: ArgoApplication): { from: string; to: string }[] {
  const running = ((app as ArgoAppFull).status?.summary?.images ?? []).map((i) => ({ image: i, parts: splitImage(i) }));
  const changes: { from: string; to: string }[] = [];
  for (const want of desiredImages(app)) {
    const w = splitImage(want);
    const now = w ? running.find((r) => r.parts?.repo === w.repo) : undefined;
    if (w && now && now.parts!.tag !== w.tag) {
      changes.push({ from: now.image, to: want });
    }
  }
  return changes;
}

/** When the app was last synced: the finished operation, else the newest history entry. */
export function lastSyncAt(app: ArgoApplication): string | undefined {
  const a = app as ArgoAppFull;
  const history = a.status?.history ?? [];
  return a.status?.operationState?.finishedAt ?? history[history.length - 1]?.deployedAt;
}

/** A manual app that only waits for its sync: OutOfSync, not degraded or missing, last sync not failed. */
export function isReadyToSync(app: ArgoApplication, automated: boolean): boolean {
  const a = app as ArgoAppFull;
  const health = a.status?.health?.status;
  const phase = a.status?.operationState?.phase;
  return (
    !automated &&
    a.status?.sync?.status === 'OutOfSync' &&
    health !== 'Degraded' &&
    health !== 'Missing' &&
    phase !== 'Failed' &&
    phase !== 'Error'
  );
}

export function pendingSync(
  app: ArgoApplication,
  canSync: boolean,
  switches: { prune: boolean; replace: boolean } = { prune: false, replace: false },
): PendingSync {
  const a = app as ArgoAppFull;
  const ns = a.metadata.namespace ?? 'argocd';
  const dest = a.spec?.destination;
  const history = a.status?.history ?? [];
  const resources: PendingSyncResource[] = (a.status?.resources ?? [])
    .filter((r) => r.status === 'OutOfSync' || r.requiresPruning)
    .map((r) => ({
      kind: r.kind,
      name: r.name,
      ...(r.namespace ? { namespace: r.namespace } : {}),
      change: r.requiresPruning ? 'prune' : r.health?.status === 'Missing' ? 'new' : 'update',
    }));
  const last = lastSyncAt(app);
  const synced = short(a.status?.operationState?.syncResult?.revision ?? history[history.length - 1]?.revision);
  const target = short(a.status?.sync?.revision);
  return {
    id: `argocd/${ns}/${a.metadata.name}/sync`,
    namespace: ns,
    app: a.metadata.name,
    ...(a.spec?.project ? { project: a.spec.project } : {}),
    ...(dest?.namespace ? { destination: dest.namespace } : {}),
    ...(last ? { lastSyncAt: last } : {}),
    ...(synced ? { syncedRevision: synced } : {}),
    ...(target ? { targetRevision: target } : {}),
    resources,
    images: imageChanges(app),
    canSync,
    offer: syncOffer(app, switches),
  };
}
