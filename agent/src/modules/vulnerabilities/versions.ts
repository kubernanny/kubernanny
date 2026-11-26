import type { OsvPackage } from '../../discovery/catalog';

/**
 * The release a tag or Kubernetes version names, as OSV compares it:
 * "v1.33.4+rke2r1" -> "1.33.4", "v1.12.0-build20250218" -> "1.12.0",
 * "8.1-alpine" -> "8.1.0". OSV's Go ranges use plain "1.33.4" and match
 * build metadata loosely at best, so distribution suffixes (+rke2r1, +k3s1,
 * -eks-…) and image flavours (-alpine, -rootless, -build…) are cut, and the
 * patch level is filled in because Go versions always have three parts.
 * Anything that does not start with a version (latest, a date, a digest) has
 * no release to look up: null. A calendar tag (2024.10.15, 2024.10) counts
 * as a date too, unless the catalog says the project uses calendar versions
 * (`calver`).
 */
export function releaseVersion(tag: string | undefined, options: { calver?: boolean } = {}): string | null {
  const m = /^v?(\d{1,6})\.(\d{1,6})(?:\.(\d{1,6}))?/.exec(tag ?? '');
  if (!m) {
    return null;
  }
  if (!options.calver && isCalendarYear(m[1]!)) {
    return null;
  }
  return `${Number(m[1])}.${Number(m[2])}.${Number(m[3] ?? 0)}`;
}

/** A four-digit year where a major version would be: 2024.10.15 is a date, not release 2024. */
function isCalendarYear(major: string): boolean {
  return /^(19|20|21)\d\d$/.test(major);
}

/** The OSV package for a component at a version, or null when the catalog entry does not cover it. */
export function osvPackageFor(
  pkg: OsvPackage,
  version: string,
  image?: string,
): { ecosystem: string; name: string } | null {
  if (pkg.image && !(image && pkg.image.test(image))) {
    return null;
  }
  const major = Number(version.split('.')[0]);
  if (pkg.minMajor !== undefined && major < pkg.minMajor) {
    return null;
  }
  return { ecosystem: pkg.ecosystem, name: pkg.goMajor && major >= 2 ? `${pkg.name}/v${major}` : pkg.name };
}

interface Parsed {
  nums: number[];
  pre: string[] | null;
}

function parse(v: string): Parsed {
  const core = v.replace(/^v/, '').split('+')[0];
  const dash = core.indexOf('-');
  const main = dash < 0 ? core : core.slice(0, dash);
  return { nums: main.split('.').map((x) => Number(x) || 0), pre: dash < 0 ? null : core.slice(dash + 1).split('.') };
}

/** Semver order (prereleases before the release), lenient enough for PyPI and crates.io release numbers. */
export function compareVersions(a: string, b: string): number {
  if (a === '0' || b === '0') {
    // OSV's "introduced: 0" means "since the beginning".
    return a === b ? 0 : a === '0' ? -1 : 1;
  }
  const x = parse(a);
  const y = parse(b);
  for (let i = 0; i < Math.max(x.nums.length, y.nums.length); i++) {
    const d = (x.nums[i] ?? 0) - (y.nums[i] ?? 0);
    if (d !== 0) {
      return Math.sign(d);
    }
  }
  if (!x.pre || !y.pre) {
    return x.pre ? -1 : y.pre ? 1 : 0;
  }
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i];
    const q = y.pre[i];
    if (p === undefined || q === undefined) {
      return p === undefined ? -1 : 1;
    }
    const pn = /^\d+$/.test(p);
    const qn = /^\d+$/.test(q);
    const d = pn && qn ? Number(p) - Number(q) : pn ? -1 : qn ? 1 : p.localeCompare(q);
    if (d !== 0) {
      return Math.sign(d);
    }
  }
  return 0;
}

/**
 * Go pseudo-versions ("1.9.2-0.20260616075434-82ef13993059") name a commit,
 * not a release. Some modules (Grafana, Harbor) only have those as fixes, so
 * they say nothing about which release to install.
 */
export const isPseudoVersion = (v: string) => /-(0\.)?\d{14}-[0-9a-f]{12}$/.test(v);
