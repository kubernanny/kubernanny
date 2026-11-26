/**
 * The sync options a sync from the app can carry (docs/CHECKS.md, "Sync
 * options"), read from the Application only:
 *
 * - prune: `status.resources[].requiresPruning` lists what Argo CD deletes on
 *   a sync with prune; without it a sync leaves those resources standing.
 * - Server-Side Apply: offered as a fix for a refused patch, unless it is in
 *   effect already (the app's own `syncPolicy.syncOptions`, or the options
 *   of the last sync).
 * - Replace: `kubectl replace` instead of a patch, offered when the last sync
 *   failed because Kubernetes refused the merged object. With Server-Side
 *   Apply a list entry another field manager still owns (the old port 80
 *   next to the new 8080, both named "http") stays, so SSA alone does not
 *   help there; a replace writes the object exactly as Git has it. A field
 *   that cannot change after creation ("field is immutable") refuses a
 *   replace as well, so neither is offered for it: the object has to be
 *   deleted and created again.
 */
import type { SyncFailureKind, SyncOffer, SyncResource } from './types';

/** More resources to prune than this: prune is not offered from the app, the confirmation could not list them all. */
export const SYNC_PRUNE_LIMIT = 50;
const MESSAGE_LIMIT = 600;

export const SERVER_SIDE_APPLY = 'ServerSideApply=true';
export const REPLACE = 'Replace=true';

interface ArgoSyncFields {
  metadata: { name: string; namespace?: string };
  spec?: { syncPolicy?: { syncOptions?: unknown } };
  status?: {
    operationState?: {
      phase?: string;
      message?: string;
      operation?: { sync?: { syncOptions?: unknown } };
    };
    resources?: { kind: string; name: string; namespace?: string; requiresPruning?: boolean }[];
  };
}

function options(list: unknown): string[] {
  return Array.isArray(list) ? list.filter((o): o is string => typeof o === 'string') : [];
}

/** The app's own sync options (`spec.syncPolicy.syncOptions`): a sync from kubectl does not get them by itself, so the agent copies them. */
export function appSyncOptions(app: ArgoSyncFields): string[] {
  return options(app.spec?.syncPolicy?.syncOptions);
}

export function serverSideInEffect(app: ArgoSyncFields): boolean {
  return [...appSyncOptions(app), ...options(app.status?.operationState?.operation?.sync?.syncOptions)].includes(
    SERVER_SIDE_APPLY,
  );
}

/** What the API server refused, from Argo CD's operation message; undefined when the sync failed for another reason. */
export function patchFailureKind(message: string | undefined): SyncFailureKind | undefined {
  if (!message) {
    return undefined;
  }
  if (/field is immutable/i.test(message)) {
    return 'immutable';
  }
  if (/Duplicate value/.test(message)) {
    return 'duplicate';
  }
  return /\bis invalid\b/.test(message) ? 'invalid' : undefined;
}

export function resourceKey(r: SyncResource): string {
  return `${r.kind}/${r.namespace ?? ''}/${r.name}`;
}

/** Everything the Application says a sync with prune would delete. */
export function pruneResources(app: ArgoSyncFields): SyncResource[] {
  return (app.status?.resources ?? [])
    .filter((r) => r.requiresPruning === true)
    .map((r) => ({ kind: r.kind, name: r.name, ...(r.namespace ? { namespace: r.namespace } : {}) }));
}

/** The offer of one app; `canPrune` and `canReplace` follow the switches (`argocd-sync-prune`, `argocd-sync-replace`). */
export function syncOffer(app: ArgoSyncFields, switches: { prune: boolean; replace: boolean }): SyncOffer {
  const all = pruneResources(app);
  const op = app.status?.operationState;
  const failed = op?.phase === 'Failed' || op?.phase === 'Error';
  const kind = failed ? patchFailureKind(op?.message) : undefined;
  const pruneMore = all.length > SYNC_PRUNE_LIMIT;
  return withSwitches(
    {
      prune: all.slice(0, SYNC_PRUNE_LIMIT),
      ...(pruneMore ? { pruneMore } : {}),
      serverSide: serverSideInEffect(app),
      ...(kind ? { failure: { kind, message: op!.message!.slice(0, MESSAGE_LIMIT) } } : {}),
      canPrune: false,
      canReplace: false,
    },
    switches,
  );
}

/** `canPrune` and `canReplace` as the switches are now (the module run applies them to every issue's sync). */
export function withSwitches(offer: SyncOffer, switches: { prune: boolean; replace: boolean }): SyncOffer {
  return {
    ...offer,
    canPrune: switches.prune && offer.prune.length > 0 && !offer.pruneMore,
    canReplace: switches.replace && offer.failure !== undefined && offer.failure.kind !== 'immutable',
  };
}
