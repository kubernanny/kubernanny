/**
 * The Kubernanny relay as a Cloudflare Worker: the same HTTP API as the Node
 * relay (docs/RELAY.md), with one Durable Object per agent id holding the
 * agent's WebSocket. The Worker only routes; see agent-object.ts.
 */
import { corsHeaders, parseRoute } from '../../src/core/http';
import { parseLimits } from '../../src/core/limits';
import { AgentObjectCore, AgentObjectState, HibernatableSocket, refuse, stringVars } from './agent-object';
import { durableTokenGate, TokenLimiterCore, TokenLimiterNamespace } from './token-limiter';

export interface Env {
  AGENTS: DurableObjectNamespace;
  /** One object per FCM token digest: the relay-wide per-token push limit (wrangler.toml). */
  TOKENS?: DurableObjectNamespace;
  [variable: string]: unknown;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const route = parseRoute(url.pathname);
    const cors = corsHeaders(request.headers.get('origin'), parseLimits(stringVars(env)).corsOrigins);
    if (!route) {
      return withHeaders(refuse('RELAY_NOT_FOUND'), cors);
    }
    if (route.kind === 'health') {
      return Response.json({ ok: true });
    }
    if (route.kind === 'connect') {
      if (request.method !== 'GET' || request.headers.get('upgrade')?.toLowerCase() !== 'websocket') {
        return refuse('RELAY_BAD_REQUEST');
      }
      return env.AGENTS.get(env.AGENTS.idFromName(route.agentId)).fetch(request);
    }
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }
    if (request.method !== 'POST') {
      return withHeaders(refuse('RELAY_NOT_FOUND'), cors);
    }
    const answer = await env.AGENTS.get(env.AGENTS.idFromName(route.agentId)).fetch(request);
    return withHeaders(answer, cors);
  },
};

/** The Durable Object class Cloudflare instantiates (binding AGENTS in wrangler.toml). */
export class AgentObject {
  private readonly core: AgentObjectCore;

  constructor(state: DurableObjectState, env: Env) {
    this.core = new AgentObjectCore(
      state as unknown as AgentObjectState,
      env,
      {
        newSocketPair: () => {
          const pair = new WebSocketPair();
          return [pair[0], pair[1] as unknown as HibernatableSocket];
        },
        autoResponse: (req, res) => new WebSocketRequestResponsePair(req, res),
        upgradeResponse: (client) => new Response(null, { status: 101, webSocket: client as WebSocket }),
      },
      undefined,
      env.TOKENS ? durableTokenGate(env.TOKENS as unknown as TokenLimiterNamespace) : undefined,
    );
  }

  fetch(request: Request): Promise<Response> {
    const route = parseRoute(new URL(request.url).pathname);
    if (route?.kind !== 'connect' && route?.kind !== 'call') {
      return Promise.resolve(refuse('RELAY_NOT_FOUND'));
    }
    return this.core.fetch(request, route.kind, route.agentId);
  }

  webSocketMessage(socket: WebSocket, message: ArrayBuffer | string): Promise<void> {
    return this.core.webSocketMessage(socket as unknown as HibernatableSocket, message);
  }

  webSocketClose(socket: WebSocket): Promise<void> {
    return this.core.webSocketClose(socket as unknown as HibernatableSocket);
  }

  webSocketError(socket: WebSocket): Promise<void> {
    return this.core.webSocketError(socket as unknown as HibernatableSocket);
  }

  alarm(): Promise<void> {
    return this.core.alarm();
  }
}

/** The per-token push limit's object (binding TOKENS in wrangler.toml), named by the token's digest. */
export class TokenLimiter {
  private readonly core: TokenLimiterCore;

  constructor(state: DurableObjectState, env: Env) {
    this.core = new TokenLimiterCore(state.storage, env);
  }

  fetch(request: Request): Promise<Response> {
    return this.core.fetch(request);
  }
}

function withHeaders(response: Response, headers: Record<string, string>): Response {
  const copy = new Response(response.body, response);
  for (const [name, value] of Object.entries(headers)) {
    copy.headers.set(name, value);
  }
  return copy;
}
