/**
 * Lists the tags of public images through the OCI distribution API
 * (`GET /v2/<name>/tags/list`), with the anonymous token flow the big
 * registries use: a 401 names a token realm, the client asks it for a pull
 * token for that one repository, then asks again. What leaves the cluster is
 * the repository name (in both URLs) and nothing else: no tag, no cluster
 * data, no credentials, a fixed User-Agent.
 *
 * Answers are kept 12 h; when a registry cannot be reached, answers up to
 * 7 days old are used, and that registry is left alone for 15 minutes.
 */
import { readCapped } from '../../util/read-capped';
import { ImageRef, refKey, Registry, TAG } from './image-ref';

export interface TagSource {
  /** Every tag the registry lists for the repository. Throws when the registry cannot be asked and no usable answer is cached. */
  tags(ref: ImageRef, now: Date): Promise<string[]>;
}

export const TAGS_TTL_MS = 12 * 3_600_000;
const STALE_MAX_MS = 7 * 24 * 3_600_000;
export const REGISTRY_BACKOFF_MS = 15 * 60_000;
const MAX_PAGES = 10;
const MAX_TAGS = 20_000;
const MAX_REDIRECTS = 3;
const USER_AGENT = 'kubernanny-agent';
/** One page of 1000 tags is ~30 KB; a token answer a few KB. */
const REGISTRY_MAX_RESPONSE = 2 * 1024 * 1024;
/** Repositories remembered; a cluster has far fewer distinct images. */
const MAX_CACHED = 2000;

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

export class RegistryClient implements TagSource {
  private readonly cache = new Map<string, { at: number; tags: string[] }>();
  private readonly failures = new Map<string, { at: number; error: unknown }>();

  constructor(
    private readonly fetchFn: Fetch = (url, init) => fetch(url, init),
    private readonly timeoutMs = 20_000,
  ) {}

  async tags(ref: ImageRef, now: Date): Promise<string[]> {
    const t = now.getTime();
    const key = refKey(ref);
    this.prune(t);
    const hit = this.cache.get(key);
    if (hit && t - hit.at < TAGS_TTL_MS) {
      return hit.tags;
    }
    try {
      const failure = this.failures.get(ref.registry.name);
      if (failure && t - failure.at < REGISTRY_BACKOFF_MS) {
        throw failure.error;
      }
      let tags: string[];
      try {
        tags = await this.list(ref);
      } catch (err) {
        this.failures.set(ref.registry.name, { at: t, error: err });
        throw err;
      }
      this.failures.delete(ref.registry.name);
      this.cache.set(key, { at: t, tags });
      return tags;
    } catch (err) {
      if (hit && t - hit.at < STALE_MAX_MS) {
        return hit.tags;
      }
      throw err;
    }
  }

  /** Drops answers past the stale window and old failures, then the oldest answers beyond MAX_CACHED. */
  private prune(t: number): void {
    for (const [key, entry] of this.cache) {
      if (t - entry.at >= STALE_MAX_MS) {
        this.cache.delete(key);
      }
    }
    for (const [key, entry] of this.failures) {
      if (t - entry.at >= REGISTRY_BACKOFF_MS) {
        this.failures.delete(key);
      }
    }
    for (const key of this.cache.keys()) {
      if (this.cache.size <= MAX_CACHED) {
        break;
      }
      this.cache.delete(key);
    }
  }

  private async list(ref: ImageRef): Promise<string[]> {
    const tags: string[] = [];
    let token: string | undefined;
    let url = `${ref.registry.api}/v2/${ref.repository}/tags/list?n=1000`;
    for (let page = 0; page < MAX_PAGES && tags.length < MAX_TAGS; page++) {
      let res = await this.get(ref.registry, url, token);
      if (res.status === 401 && token === undefined) {
        token = await this.token(ref, res.headers.get('www-authenticate'));
        res = await this.get(ref.registry, url, token);
      }
      if (!res.ok) {
        throw new Error(`${ref.registry.name}: HTTP ${res.status}`);
      }
      const body = (JSON.parse(await readCapped(res, REGISTRY_MAX_RESPONSE)) ?? {}) as { tags?: unknown };
      tags.push(
        ...(Array.isArray(body.tags) ? body.tags.filter((x): x is string => typeof x === 'string' && TAG.test(x)) : []),
      );
      const next = nextPage(res.headers.get('link'));
      if (!next) {
        break;
      }
      // Only a path on the same registry: a Link header must not send the client elsewhere.
      url = `${ref.registry.api}${next}`;
    }
    return tags.slice(0, MAX_TAGS);
  }

  /** Follows redirects only to the hosts the registry is known to send clients to. */
  private async get(registry: Registry, url: string, token: string | undefined): Promise<Response> {
    let current = url;
    for (let i = 0; i <= MAX_REDIRECTS; i++) {
      const headers: Record<string, string> = { accept: 'application/json', 'user-agent': USER_AGENT };
      // The token belongs to the registry; never hand it to a redirect target.
      if (token && current.startsWith(`${registry.api}/`)) {
        headers['authorization'] = `Bearer ${token}`;
      }
      const res = await this.fetchFn(current, {
        headers,
        redirect: 'manual',
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (res.status < 300 || res.status >= 400) {
        return res;
      }
      const location = res.headers.get('location');
      const target = location ? new URL(location, current) : null;
      if (!target || target.protocol !== 'https:' || !registry.redirectHosts?.test(target.hostname)) {
        throw new Error(`${registry.name}: redirect to an unexpected host`);
      }
      current = target.toString();
    }
    throw new Error(`${registry.name}: too many redirects`);
  }

  /** The anonymous pull token, from the realm the 401 named, if that realm is one this registry is known to use. */
  private async token(ref: ImageRef, header: string | null): Promise<string> {
    const challenge = parseChallenge(header);
    const realm = challenge?.realm ? safeUrl(challenge.realm) : null;
    if (!realm || realm.protocol !== 'https:' || !ref.registry.tokenHosts.includes(realm.hostname)) {
      throw new Error(`${ref.registry.name}: no anonymous access`);
    }
    if (challenge!.service) {
      realm.searchParams.set('service', challenge!.service);
    }
    realm.searchParams.set('scope', `repository:${ref.repository}:pull`);
    const res = await this.fetchFn(realm.toString(), {
      headers: { accept: 'application/json', 'user-agent': USER_AGENT },
      redirect: 'error',
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) {
      throw new Error(`${ref.registry.name}: token HTTP ${res.status}`);
    }
    const body = (JSON.parse(await readCapped(res, REGISTRY_MAX_RESPONSE)) ?? {}) as {
      token?: unknown;
      access_token?: unknown;
    };
    const token =
      typeof body.token === 'string' ? body.token : typeof body.access_token === 'string' ? body.access_token : '';
    if (!token || token.length > 16_384) {
      throw new Error(`${ref.registry.name}: no token`);
    }
    return token;
  }
}

/** `Bearer realm="https://auth.docker.io/token",service="registry.docker.io",scope="…"` */
export function parseChallenge(header: string | null): { realm?: string; service?: string } | null {
  if (!header || !/^bearer\s/i.test(header)) {
    return null;
  }
  const out: Record<string, string> = {};
  for (const m of header.matchAll(/(\w+)="([^"]*)"/g)) {
    out[m[1]!.toLowerCase()] = m[2]!;
  }
  return { realm: out['realm'], service: out['service'] };
}

/** The path of `<…>; rel="next"`, only when it is a path on the same host. */
export function nextPage(link: string | null): string | null {
  const m = link ? /<([^>]+)>\s*;\s*rel="?next"?/.exec(link) : null;
  return m && /^\/v2\/[^\s]*$/.test(m[1]!) ? m[1]! : null;
}

function safeUrl(s: string): URL | null {
  try {
    return new URL(s);
  } catch {
    return null;
  }
}
