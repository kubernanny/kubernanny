/**
 * A small client for OSV.dev's API (https://google.github.io/osv.dev/api/),
 * or any mirror serving the same two routes: `POST /v1/querybatch` answers
 * which advisories affect a package version (ids only), `GET /v1/vulns/{id}`
 * has the details. What goes out is ecosystem, package name and version, and
 * advisory ids; nothing about the cluster.
 *
 * Answers are cached in memory for 12 h, so the check, which runs every
 * minute, asks at most twice a day per version. When the database cannot be
 * reached, answers up to 7 days old are used and marked stale.
 */
import { TextError, errorText, t as msg } from '../../i18n/text';

export interface OsvQuery {
  ecosystem: string;
  name: string;
  version: string;
}

export interface OsvEvent {
  introduced?: string;
  fixed?: string;
  last_affected?: string;
  limit?: string;
}

/** The part of an OSV record the check reads (https://ossf.github.io/osv-schema/). */
export interface OsvVuln {
  id: string;
  aliases?: string[];
  summary?: string;
  severity?: { type: string; score: string }[];
  database_specific?: { severity?: string };
  affected?: {
    package?: { ecosystem?: string; name?: string };
    ranges?: { type: string; events: OsvEvent[] }[];
  }[];
}

export interface VulnLookup {
  /** Per query, in order: every advisory affecting that version. */
  results: OsvVuln[][];
  /** Set when the database could not be reached and older answers were used. */
  staleSince?: Date;
}

export interface VulnDb {
  /** Shown in the module's stats and its privacy note. */
  readonly host: string;
  lookup(queries: OsvQuery[], now: Date): Promise<VulnLookup>;
}

export const OSV_TTL_MS = 12 * 3_600_000;
const STALE_MAX_MS = 7 * 24 * 3_600_000;
/** After a failed lookup OSV.dev is left alone this long: the check runs every minute, and each try can wait 20 s. */
export const OSV_BACKOFF_MS = 15 * 60_000;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{1,80}$/;

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

export class OsvClient implements VulnDb {
  readonly host: string;
  private readonly queries = new Map<string, { at: number; ids: string[] }>();
  private readonly vulns = new Map<string, { at: number; vuln: OsvVuln }>();
  private failure: { at: number; error: unknown } | null = null;

  constructor(
    private readonly baseUrl: string,
    private readonly fetchFn: Fetch = (url, init) => fetch(url, init),
    private readonly timeoutMs = 20_000,
  ) {
    this.host = new URL(baseUrl).host;
  }

  async lookup(queries: OsvQuery[], now: Date): Promise<VulnLookup> {
    const t = now.getTime();
    const keyOf = (q: OsvQuery) => `${q.ecosystem}|${q.name}|${q.version}`;
    try {
      if (this.failure && t - this.failure.at < OSV_BACKOFF_MS) {
        throw this.failure.error;
      }
      const due = queries.filter((q) => {
        const hit = this.queries.get(keyOf(q));
        return !hit || t - hit.at >= OSV_TTL_MS;
      });
      try {
        if (due.length > 0) {
          const answers = await this.batch(due);
          due.forEach((q, i) => this.queries.set(keyOf(q), { at: t, ids: answers[i] }));
        }
        const ids = [...new Set(queries.flatMap((q) => this.queries.get(keyOf(q))!.ids))];
        await this.details(ids.filter((id) => !this.vulns.has(id) || t - this.vulns.get(id)!.at >= OSV_TTL_MS), t);
        this.failure = null;
      } catch (err) {
        this.failure = { at: t, error: err };
        throw err;
      }
      return { results: queries.map((q) => this.resolve(this.queries.get(keyOf(q))!.ids)) };
    } catch (err) {
      const cached = queries.map((q) => this.queries.get(keyOf(q)));
      if (cached.every((c) => c && t - c.at < STALE_MAX_MS && c.ids.every((id) => this.vulns.has(id)))) {
        return { results: cached.map((c) => this.resolve(c!.ids)), staleSince: new Date(Math.min(...cached.map((c) => c!.at))) };
      }
      throw new TextError(msg('vulnerabilities.unreachable', { host: this.host, message: errorText(err) }));
    }
  }

  private resolve(ids: string[]): OsvVuln[] {
    return ids.map((id) => this.vulns.get(id)?.vuln).filter((v): v is OsvVuln => v !== undefined);
  }

  private async batch(queries: OsvQuery[]): Promise<string[][]> {
    const body = { queries: queries.map((q) => ({ package: { ecosystem: q.ecosystem, name: q.name }, version: q.version })) };
    const res = await this.request(`${this.baseUrl}/v1/querybatch`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const results = (res as { results?: { vulns?: { id?: unknown }[] }[] }).results;
    if (!Array.isArray(results) || results.length !== queries.length) {
      throw new TextError(msg('vulnerabilities.unexpectedAnswer'));
    }
    return results.map((r) => (r?.vulns ?? []).map((v) => v?.id).filter((id): id is string => typeof id === 'string' && ID.test(id)));
  }

  private async details(ids: string[], t: number): Promise<void> {
    // A handful at a time: a first run can need a few hundred records.
    for (let i = 0; i < ids.length; i += 8) {
      await Promise.all(
        ids.slice(i, i + 8).map(async (id) => {
          const vuln = sanitize(await this.request(`${this.baseUrl}/v1/vulns/${encodeURIComponent(id)}`, { method: 'GET' }), id);
          this.vulns.set(id, { at: t, vuln });
        }),
      );
    }
  }

  private async request(url: string, init: RequestInit): Promise<unknown> {
    const res = await this.fetchFn(url, { ...init, signal: AbortSignal.timeout(this.timeoutMs) });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
    return res.json();
  }
}

/** The database is outside the cluster: keep only well-formed fields, short. */
export function sanitize(raw: unknown, id: string): OsvVuln {
  const r = (raw ?? {}) as Record<string, unknown>;
  const strings = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
  const severity = Array.isArray(r['severity'])
    ? (r['severity'] as unknown[]).filter((s): s is { type: string; score: string } => typeof (s as { type?: unknown })?.type === 'string' && typeof (s as { score?: unknown })?.score === 'string')
    : [];
  const dbSeverity = (r['database_specific'] as { severity?: unknown } | undefined)?.severity;
  const affected = Array.isArray(r['affected']) ? (r['affected'] as OsvVuln['affected'] & unknown[]) : [];
  return {
    id,
    aliases: strings(r['aliases']).filter((a) => ID.test(a)),
    summary: typeof r['summary'] === 'string' ? r['summary'].slice(0, 200) : undefined,
    severity,
    database_specific: typeof dbSeverity === 'string' ? { severity: dbSeverity } : undefined,
    affected: affected.map((a) => ({
      package: { ecosystem: String(a?.package?.ecosystem ?? ''), name: String(a?.package?.name ?? '') },
      ranges: (Array.isArray(a?.ranges) ? a.ranges : []).map((range) => ({
        type: String(range?.type ?? ''),
        events: (Array.isArray(range?.events) ? range.events : []).map((e) => ({
          introduced: typeof e?.introduced === 'string' ? e.introduced : undefined,
          fixed: typeof e?.fixed === 'string' ? e.fixed : undefined,
          last_affected: typeof e?.last_affected === 'string' ? e.last_affected : undefined,
        })),
      })),
    })),
  };
}
