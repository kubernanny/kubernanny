import { Translator } from '../i18n/translator';
import { bytes, cores } from './format';

/** "requests 2,5, limits 6": the line under a CPU or RAM bar; null limits (an older agent) leave the line out. */
export function resourceNote(kind: 'cpu' | 'memory', requested: number | undefined, limit: number | null | undefined, unlimited: number, tr: Translator): string {
  if (requested === undefined) {
    return '';
  }
  const fmt = (v: number) => (kind === 'cpu' ? cores(v, tr.lang) : bytes(v, tr.lang));
  if (!limit) {
    return tr.t('resources.requestsNoLimits', { requests: fmt(requested) });
  }
  return unlimited > 0
    ? tr.t('resources.requestsSomeLimits', { requests: fmt(requested), limits: fmt(limit), count: unlimited })
    : tr.t('resources.requestsLimits', { requests: fmt(requested), limits: fmt(limit) });
}

/**
 * The line under a node's CPU or RAM bar, for the sum over its pods:
 * "Requests 2,5, Limits 6,4 (überbucht), 3 Pods ohne Limit". Overbooked:
 * the limits add up to more than the node has, so not every pod can reach its
 * limit at once.
 */
export function nodeResourceNote(kind: 'cpu' | 'memory', requested: number, limit: number | undefined, allocatable: number, podsWithoutLimit: number | undefined, tr: Translator): string {
  const fmt = (v: number) => (kind === 'cpu' ? cores(v, tr.lang) : bytes(v, tr.lang));
  const parts = [tr.t('resources.requests', { requests: fmt(requested) })];
  if (limit !== undefined) {
    parts.push(limit > allocatable && allocatable > 0 ? tr.t('resources.limitsOver', { limits: fmt(limit) }) : tr.t('resources.limits', { limits: fmt(limit) }));
  }
  if (podsWithoutLimit) {
    parts.push(tr.n('resources.podsWithoutLimit', podsWithoutLimit));
  }
  return parts.join(', ');
}
