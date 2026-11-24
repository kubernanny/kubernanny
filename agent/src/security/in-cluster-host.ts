/**
 * A host that plain HTTP or WS may go to: this machine, or a Service inside
 * the cluster (`ntfy.ntfy.svc`, `relay.kubernanny.svc.cluster.local`).
 * Everything else must use TLS. One rule for every URL the agent is given.
 */
export function isInClusterHost(hostname: string): boolean {
  return /(\.svc|\.svc\.cluster\.local)$/.test(hostname) || ['localhost', '127.0.0.1', '[::1]'].includes(hostname);
}
