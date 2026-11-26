import { ClusterConfig } from '../agent.model';

/**
 * Where a tap on a push leads. The agent does not know the app's local
 * cluster id, but the app registered one push key per cluster, and every
 * push names its key id (`k`). So the key id resolves to the cluster here,
 * on the device; anything that resolves to no cluster in the list leads
 * nowhere. Android resolves it natively (its key entry holds the cluster
 * id) and opens `kubernanny://cluster?id=…`, which goes through
 * `knownClusterId` like a widget tap.
 */
export function clusterIdForPushKey(
  kid: unknown,
  clusters: readonly ClusterConfig[],
): string | null {
  if (typeof kid !== 'string' || !/^[A-Za-z0-9_-]{16}$/.test(kid)) {
    return null;
  }
  return clusters.find((c) => !c.demo && c.push?.kid === kid)?.id ?? null;
}

/** An id from outside the app (widget, push, link) only counts when it names a cluster in the list. */
export function knownClusterId(
  id: string | null,
  clusters: readonly ClusterConfig[],
): string | null {
  return id !== null && clusters.some((c) => c.id === id) ? id : null;
}
