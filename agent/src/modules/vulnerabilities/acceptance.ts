/**
 * The pure part of accepting advisories, shared by the service and the
 * check (which must not import the service: the service needs the settings,
 * and those load every check).
 */

/** The durations the app offers. A year at most: an accepted advisory is looked at again. */
export const ACCEPT_DAYS = [30, 90, 365] as const;
export const MAX_ACCEPTED = 500;
const MAX_REASON = 200;
export const DAY = 86_400_000;

/** One advisory someone marked as "does not apply here" on one component. */
export interface Acceptance {
  until: number;
  /** When and by whom (device name), for the module sheet and the audit trail. */
  at: number;
  by: string;
  reason?: string;
}

/** What the vulnerabilities check needs to know: whether accepting counts at all, and what is accepted. */
export interface AcceptanceState {
  allowed: boolean;
  accepted: ReadonlyMap<string, Acceptance>;
}

export const acceptanceKey = (component: string, advisory: string) => `${component}|${advisory}`;

/**
 * Catalog ids, custom component ids and "kubernetes"; for a Trivy Operator
 * finding the workload, `trivy:<namespace>:<kind>:<name>` (long enough for a
 * 63-character namespace and a 253-character name). Advisory ids as OSV and
 * Trivy write them.
 */
export const COMPONENT = /^[a-z0-9][a-z0-9:._-]{0,340}$/;
export const ADVISORY = /^[A-Za-z0-9][A-Za-z0-9._:-]{1,80}$/;

/** Control and format characters out, whitespace collapsed: the reason ends up in logs and on other devices. */
export function cleanReason(raw: unknown): string | undefined {
  if (typeof raw !== 'string') {
    return undefined;
  }
  const text = raw
    .replace(/[\p{Cc}\p{Cf}]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_REASON);
  return text || undefined;
}

export function parseAccepted(text: string | undefined): Map<string, Acceptance> {
  try {
    const raw = JSON.parse(text ?? '{}') as Record<string, Partial<Acceptance>>;
    const out = new Map<string, Acceptance>();
    for (const [key, a] of Object.entries(raw).slice(0, MAX_ACCEPTED)) {
      if (typeof a?.until === 'number' && typeof a.at === 'number' && typeof a.by === 'string') {
        const reason = cleanReason(a.reason);
        out.set(key, { until: a.until, at: a.at, by: a.by.slice(0, 100), ...(reason ? { reason } : {}) });
      }
    }
    return out;
  } catch {
    return new Map();
  }
}

/** The acceptance component of a workload Trivy Operator scanned; lower case, so it fits COMPONENT. */
export const trivyComponentKey = (namespace: string, kind: string, name: string) =>
  `trivy:${namespace}:${kind.toLowerCase()}:${name}`;

/**
 * The component an advisory of an issue is accepted on: `vulnerabilities/<id>`
 * is the built-in lookup's component, `trivy/<ns>/<kind>/<name>` a workload.
 * Mirrored by `acceptComponentOf` in the app.
 */
export function acceptComponentOfIssue(id: string): string | null {
  if (id.startsWith('vulnerabilities/')) {
    return id.slice('vulnerabilities/'.length);
  }
  const parts = id.split('/');
  return parts.length === 4 && parts[0] === 'trivy' ? trivyComponentKey(parts[1], parts[2], parts[3]) : null;
}
