import { isInClusterHost } from '../security/in-cluster-host';

/**
 * RELAY_URL: where the agent dials out to. `wss://` in general; plain `ws://`
 * only to this machine or a service inside the cluster (a self-hosted relay
 * next to the agent, tests). The relay sees only ciphertext either way, but
 * TLS keeps the agent id and the timing of calls off the wire, too.
 */
export function checkRelayUrl(raw: string | undefined): string | undefined {
  if (!raw) {
    return undefined;
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('RELAY_URL is not a URL');
  }
  const internal = isInClusterHost(url.hostname);
  if (url.protocol !== 'wss:' && !(url.protocol === 'ws:' && internal)) {
    throw new Error('RELAY_URL must use wss:// (plain ws:// only for localhost or in-cluster *.svc hosts)');
  }
  if (url.search || url.hash || url.username || url.password) {
    throw new Error('RELAY_URL takes no query, fragment or credentials');
  }
  return url.toString().replace(/\/+$/, '');
}

/** The address the app calls the relay at: the same host over http(s). Goes into the pairing link. */
export function relayHttpUrl(wsUrl: string): string {
  return wsUrl.replace(/^ws(s?):/, 'http$1:');
}

/** Where the agent connects: `<relay>/v1/agents/<agentId>/ws`. */
export function relaySocketUrl(wsUrl: string, agentId: string): string {
  return `${wsUrl}/v1/agents/${agentId}/ws`;
}
