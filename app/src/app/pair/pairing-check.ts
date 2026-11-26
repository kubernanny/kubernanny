import { ClusterConfig } from '../core/agent.model';

/**
 * What pairing from a link would do to the clusters already in the app:
 * - `new`: nothing there under this address or name, a new entry is added;
 * - `again`: the same agent (same key) is there; pairing again replaces this
 *   device's key for it, after the person confirmed;
 * - `keyChanged`: an entry with this address or name pins another agent key.
 *   Refused by default: the link may come from someone posing as that
 *   cluster (their relay, their fake agent). Only an explicit "replace"
 *   goes on.
 */
export type PairingCheck =
  { kind: 'new' } | { kind: 'again' | 'keyChanged'; existing: ClusterConfig };

export function checkPairing(
  clusters: readonly ClusterConfig[],
  address: string,
  name: string | undefined,
  agentKey: string,
): PairingCheck {
  const url = address.trim().replace(/\/+$/, '');
  const matches = clusters.filter((c) => !c.demo && (c.url === url || (!!name && c.name === name)));
  const changed = matches.find((c) => c.agentKey !== agentKey);
  if (changed) {
    return { kind: 'keyChanged', existing: changed };
  }
  // The same agent: prefer the entry with this very address.
  const same = matches.find((c) => c.url === url) ?? matches[0];
  return same ? { kind: 'again', existing: same } : { kind: 'new' };
}
