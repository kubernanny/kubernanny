import { SyncOffer, SyncResource } from '../core/agent.model';
import { TranslationKey } from '../i18n/dictionary';
import { Translator } from '../i18n/translator';

const FAILURE: Record<NonNullable<SyncOffer['failure']>['kind'], TranslationKey> = {
  duplicate: 'syncOptions.failure.duplicate',
  invalid: 'syncOptions.failure.invalid',
  immutable: 'syncOptions.failure.immutable',
};

/** The agent lists at most this many resources to prune (agent/src/checks/argocd-sync-offer.ts). */
const PRUNE_LIMIT = 50;

export interface SyncOptionRow {
  title: string;
  text: string;
  /** Can be ticked; otherwise shown greyed with `note`. */
  enabled: boolean;
  note: string | null;
  recommended: boolean;
}

/** The sheet in front of a sync with options (CHECKS.md, "Sync options"), worked out once. */
export interface SyncOptionsView {
  title: string;
  /** The last sync's refusal: what Kubernetes said, and what it means. */
  failure: { message: string; explanation: string } | null;
  prune: (SyncOptionRow & { resources: { key: string; text: string }[]; intro: string }) | null;
  serverSide: SyncOptionRow | null;
  /** "Server-Side Apply is on for this app already", when that matters (after a refused patch). */
  serverSideOn: string | null;
  replace: SyncOptionRow | null;
}

export function resourceKey(r: SyncResource): string {
  return `${r.kind}/${r.namespace ?? ''}/${r.name}`;
}

/** Whether a sync needs the sheet rather than the plain question: something to delete, or a refused patch to explain. */
export function needsSyncSheet(offer: SyncOffer | undefined): offer is SyncOffer {
  return offer !== undefined && (offer.prune.length > 0 || offer.failure !== undefined);
}

export function syncOptionsView(app: string, offer: SyncOffer, tr: Translator): SyncOptionsView {
  const failure = offer.failure;
  const fixable = failure !== undefined && failure.kind !== 'immutable';
  return {
    title: tr.t('syncOptions.title', { app }),
    failure: failure
      ? { message: failure.message, explanation: tr.t(FAILURE[failure.kind]) }
      : null,
    prune:
      offer.prune.length > 0
        ? {
            title: tr.t('syncOptions.prune'),
            text: '',
            intro: tr.n('syncOptions.pruneText', offer.prune.length),
            resources: offer.prune.map((r) => ({
              key: resourceKey(r),
              text: `${r.kind} ${r.namespace ? `${r.namespace}/` : ''}${r.name}`,
            })),
            enabled: offer.canPrune,
            note: offer.pruneMore
              ? tr.t('syncOptions.pruneMore', { n: PRUNE_LIMIT })
              : offer.canPrune
                ? null
                : tr.t('syncOptions.pruneOff'),
            recommended: false,
          }
        : null,
    serverSide:
      fixable && !offer.serverSide
        ? {
            title: tr.t('syncOptions.ssa'),
            text: tr.t('syncOptions.ssaText'),
            enabled: true,
            note: null,
            recommended: failure.kind === 'invalid',
          }
        : null,
    serverSideOn: failure && offer.serverSide ? tr.t('syncOptions.ssaOn') : null,
    replace: fixable
      ? {
          title: tr.t('syncOptions.replace'),
          text: tr.t('syncOptions.replaceText'),
          enabled: offer.canReplace,
          note: offer.canReplace ? null : tr.t('syncOptions.replaceOff'),
          recommended: offer.canReplace && (failure.kind === 'duplicate' || offer.serverSide),
        }
      : null,
  };
}
