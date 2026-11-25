/**
 * "kubernanny://cluster?id=…" (a tap on a home-screen widget) -> the cluster's
 * id, or null for anything else. Only the shape of the app's own ids passes
 * (UUIDs, `demo-broken`, …): the link comes from outside the app, and the id
 * only ever selects a cluster already in the list.
 */
export function clusterLinkId(link: string): string | null {
  try {
    const u = new URL(link);
    if (u.protocol !== 'kubernanny:' || u.hostname !== 'cluster' || (u.pathname !== '' && u.pathname !== '/')) {
      return null;
    }
    const id = u.searchParams.get('id');
    return id && /^[A-Za-z0-9-]{1,64}$/.test(id) ? id : null;
  } catch {
    return null;
  }
}
