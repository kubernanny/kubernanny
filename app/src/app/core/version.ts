/**
 * The agent version this app was built against (agent/src/version.ts; a test
 * keeps the two in step). An agent that reports an older one gets an update
 * hint: worked out on the device, no request to any update server.
 */
export const KNOWN_AGENT_VERSION = '0.4.0';

export const UPGRADE_COMMAND =
  'helm upgrade kubernanny oci://ghcr.io/kubernanny/charts/kubernanny -n kubernanny --reuse-values';

/** Compares dotted versions numerically ("0.10.0" > "0.9.1"); pre-release suffixes are ignored. */
export function olderThan(version: string, than: string): boolean {
  const parts = (v: string) =>
    v
      .replace(/^v/, '')
      .split(/[.-]/)
      .slice(0, 3)
      .map((p) => Number.parseInt(p, 10) || 0);
  const a = parts(version);
  const b = parts(than);
  for (let i = 0; i < 3; i++) {
    if (a[i]! !== b[i]!) {
      return a[i]! < b[i]!;
    }
  }
  return false;
}
