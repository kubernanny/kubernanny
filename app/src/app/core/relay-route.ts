import { HttpErrorResponse } from '@angular/common/http';
import { parsePublicKey, relayAgentId } from '@kubernanny/protocol';
import { AgentInfo, ClusterConfig } from './agent.model';

/** How the app reached an agent last: its own address, or the relay (docs/RELAY.md). */
export type AgentPath = 'direct' | 'relay';

/** How long the reachability check of the direct address may take before the relay is used. */
export const PROBE_TIMEOUT_MS = 4_000;
/** A working direct path is trusted this long; any transport failure ends it early. */
export const REMEMBER_DIRECT_MS = 10 * 60_000;
/** On the relay, the direct address is tried again after this, so the app goes back to it once in the VPN. */
export const REMEMBER_RELAY_MS = 2 * 60_000;

type RelayTarget = Partial<Pick<ClusterConfig, 'relayUrl' | 'relayOff'>>;

/** The relay URL to use for this cluster, or null: none known, switched off, or not an http(s) URL. */
export function usableRelay(target: RelayTarget): string | null {
  if (!target.relayUrl || target.relayOff) {
    return null;
  }
  return relayUrlAllowed(target.relayUrl) ? target.relayUrl.replace(/\/+$/, '') : null;
}

/** https, or plain http only to this machine (a relay for development). */
export function relayUrlAllowed(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' || (u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname));
  } catch {
    return false;
  }
}

/** `POST {relay}/v1/agents/{agentId}/e2e`: the id is derived from the pinned key, nothing else is needed. */
export function relayCallUrl(relayUrl: string, agentKey: string): string {
  return `${relayUrl}/v1/agents/${relayAgentId(parsePublicKey(agentKey))}/e2e`;
}

/**
 * The call never got an answer from anyone: the network failed, it timed
 * out, or a proxy answered instead of the agent. Only then is the relay a
 * sensible second try. An answer from the agent, even an error, is not.
 */
export function transportFailure(err: unknown): boolean {
  if (err instanceof Error && err.name === 'TimeoutError') {
    return true;
  }
  return err instanceof HttpErrorResponse && (err.status === 0 || err.status === 502 || err.status === 503 || err.status === 504);
}

/** How often the app asks a paired agent in the background which relay it uses. */
export const RELAY_INFO_EVERY_MS = 60 * 60_000;

/**
 * The relay URL a cluster should store after the agent's sealed /info, or
 * null when nothing changes. Agents before the relay send no `relay` field
 * and change nothing; an agent with the relay switched off clears it.
 */
export function adoptedRelay(cluster: Pick<ClusterConfig, 'relayUrl'>, info: Pick<AgentInfo, 'relay'>): { relayUrl: string | undefined } | null {
  if (info.relay === undefined) {
    return null;
  }
  const url = info.relay && relayUrlAllowed(info.relay.url) ? info.relay.url : undefined;
  return url === cluster.relayUrl ? null : { relayUrl: url };
}

/** Which path worked per agent, and until when that is trusted. */
export class PathMemory {
  private readonly entries = new Map<string, { path: AgentPath; until: number }>();

  get(key: string, now: number): AgentPath | null {
    const entry = this.entries.get(key);
    return entry && entry.until > now ? entry.path : null;
  }

  set(key: string, path: AgentPath, now: number): void {
    this.entries.set(key, { path, until: now + (path === 'direct' ? REMEMBER_DIRECT_MS : REMEMBER_RELAY_MS) });
  }

  forget(key: string): void {
    this.entries.delete(key);
  }
}
