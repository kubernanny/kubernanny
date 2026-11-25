/**
 * The registries the `image-updates` module asks, and how. Only these: an
 * image from anywhere else is counted, never looked up, so the agent never
 * contacts a host a workload's image name happens to point at.
 */
export interface Registry {
  /** What image references name (docker.io, ghcr.io, …). */
  name: string;
  /** Where the OCI distribution API is served. */
  api: string;
  /** Hosts that may hand out the anonymous pull token (from the registry's WWW-Authenticate realm). */
  tokenHosts: string[];
  /** Hosts the API may redirect to; anything else is not followed. */
  redirectHosts?: RegExp;
}

export const REGISTRIES: readonly Registry[] = [
  { name: 'docker.io', api: 'https://registry-1.docker.io', tokenHosts: ['auth.docker.io'] },
  { name: 'ghcr.io', api: 'https://ghcr.io', tokenHosts: ['ghcr.io'] },
  { name: 'quay.io', api: 'https://quay.io', tokenHosts: ['quay.io'] },
  // registry.k8s.io sends clients on to Google Artifact Registry mirrors (<region>-docker.pkg.dev).
  { name: 'registry.k8s.io', api: 'https://registry.k8s.io', tokenHosts: [], redirectHosts: /^[a-z0-9-]+\.pkg\.dev$/ },
];

const ALIASES: Record<string, string> = { 'index.docker.io': 'docker.io', 'registry-1.docker.io': 'docker.io' };

export interface ImageRef {
  registry: Registry;
  /** "library/traefik", "cloudnative-pg/cloudnative-pg". */
  repository: string;
  tag: string;
}

const REPO = /^[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*(?:\/[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*)*$/;
/** An OCI tag as the distribution spec allows it. */
export const TAG = /^[\w][\w.-]{0,127}$/;

/**
 * "traefik:v3.1.2" -> docker.io library/traefik v3.1.2; "ghcr.io/a/b:1.0@sha256:…" -> ghcr.io a/b 1.0.
 * Null for an unsupported registry, a missing tag or anything malformed.
 */
export function parseImageRef(image: string): ImageRef | null {
  const noDigest = image.split('@')[0]!;
  const slash = noDigest.lastIndexOf('/');
  const colon = noDigest.lastIndexOf(':');
  if (colon <= slash) {
    return null;
  }
  const tag = noDigest.slice(colon + 1);
  let name = noDigest.slice(0, colon);
  const first = name.split('/')[0]!;
  let host = 'docker.io';
  if (name.includes('/') && (first.includes('.') || first.includes(':') || first === 'localhost')) {
    host = ALIASES[first] ?? first;
    name = name.slice(first.length + 1);
  }
  const registry = REGISTRIES.find((r) => r.name === host);
  if (!registry || !TAG.test(tag)) {
    return null;
  }
  if (registry.name === 'docker.io' && !name.includes('/')) {
    name = `library/${name}`;
  }
  return REPO.test(name) ? { registry, repository: name, tag } : null;
}

export const refKey = (r: ImageRef) => `${r.registry.name}/${r.repository}`;
