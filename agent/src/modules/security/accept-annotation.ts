import { CONTROL_CHARS } from '../../util/log-safe';
import type { FindingType } from './evaluate';

/**
 * Accepting a security hint in Git: `kubernanny.io/accept: "root: the image
 * starts runit as root and drops privileges itself"` on the workload
 * (Deployment, StatefulSet, DaemonSet, CronJob) or on its pod template.
 * The value lists entries `<key>: <reason>`, separated by commas or line
 * breaks. Only hints can be accepted: a privileged container is a warning
 * (whoever takes it over has the node) and always counts.
 */
export const ACCEPT_ANNOTATION = 'kubernanny.io/accept';

/** The keys an entry may name, in the order of the findings; docs/SECURITY-CHECKS.md lists them. */
export const ACCEPTABLE_KEYS: readonly FindingType[] = ['host-access', 'root', 'no-memory-limit', 'mutable-image'];

/** Findings that are never accepted, however the annotation reads. */
export const NEVER_ACCEPTED: readonly FindingType[] = ['privileged'];

/** Longest reason kept; a longer one is cut with an ellipsis. */
export const MAX_REASON = 200;

/** Longest annotation value read at all, and the most entries: an annotation is not a place for essays. */
const MAX_VALUE = 4096;
const MAX_ENTRIES = 20;

export interface ParsedAccept {
  /** Key to its reason. */
  accepted: Map<FindingType, string>;
  /** Keys named without a reason: not accepted. */
  missingReason: Set<FindingType>;
  /** Keys that are no finding, as written (trimmed, cut). */
  unknown: string[];
  /** Keys of findings that cannot be accepted (privileged). */
  refused: FindingType[];
}

const ACCEPTABLE = new Set<string>(ACCEPTABLE_KEYS);
const REFUSED = new Set<string>(NEVER_ACCEPTED);

function clean(text: string): string {
  return text.replace(CONTROL_CHARS, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Entries split at line breaks, and at commas that start a new `key:`, so a
 * reason may contain a comma ("runs as root, drops privileges itself").
 */
export function parseAccept(value: string | undefined): ParsedAccept {
  const out: ParsedAccept = { accepted: new Map(), missingReason: new Set(), unknown: [], refused: [] };
  if (typeof value !== 'string' || !value.trim()) {
    return out;
  }
  const entries = value
    .slice(0, MAX_VALUE)
    .split(/\r?\n|,(?=\s*[A-Za-z][\w-]*\s*:)/)
    .map((e) => e.trim())
    .filter(Boolean)
    .slice(0, MAX_ENTRIES);
  for (const entry of entries) {
    const colon = entry.indexOf(':');
    const key = clean(colon < 0 ? entry : entry.slice(0, colon)).toLowerCase();
    const reasonRaw = colon < 0 ? '' : clean(entry.slice(colon + 1));
    const reason = reasonRaw.length > MAX_REASON ? `${reasonRaw.slice(0, MAX_REASON - 1).trimEnd()}…` : reasonRaw;
    if (REFUSED.has(key)) {
      if (!out.refused.includes(key as FindingType)) {
        out.refused.push(key as FindingType);
      }
    } else if (!ACCEPTABLE.has(key)) {
      const shown = key.length > 40 ? `${key.slice(0, 39)}…` : key;
      if (shown && !out.unknown.includes(shown)) {
        out.unknown.push(shown);
      }
    } else if (out.accepted.has(key as FindingType)) {
      // The first entry for a key counts.
    } else if (reason) {
      out.accepted.set(key as FindingType, reason);
      out.missingReason.delete(key as FindingType);
    } else {
      out.missingReason.add(key as FindingType);
    }
  }
  return out;
}

/** Where an accepted entry was written. */
export type AcceptSource = 'workload' | 'pod-template';

/**
 * The workload's annotation and its pod template's together; for a key in
 * both, the workload's entry counts.
 */
export function mergeAccept(
  workload: string | undefined,
  podTemplate: string | undefined,
): ParsedAccept & { source: Map<FindingType, AcceptSource> } {
  const w = parseAccept(workload);
  const p = parseAccept(podTemplate);
  const source = new Map<FindingType, AcceptSource>();
  const accepted = new Map<FindingType, string>();
  for (const [key, reason] of w.accepted) {
    accepted.set(key, reason);
    source.set(key, 'workload');
  }
  for (const [key, reason] of p.accepted) {
    if (!accepted.has(key)) {
      accepted.set(key, reason);
      source.set(key, 'pod-template');
    }
  }
  const missingReason = new Set([...w.missingReason, ...p.missingReason].filter((k) => !accepted.has(k)));
  return {
    accepted,
    source,
    missingReason,
    unknown: [...new Set([...w.unknown, ...p.unknown])],
    refused: [...new Set([...w.refused, ...p.refused])],
  };
}
