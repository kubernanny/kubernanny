import { IdentityService } from '../auth/identity.service';
import { Reply, Route } from '../http/server';
import { E2eService } from './e2e.service';

/** Public by design: the identity is a public key, and /e2e authenticates every call itself (E2eService). */
export class E2eApi {
  constructor(
    private readonly e2e: E2eService,
    private readonly identity: IdentityService,
  ) {}

  /**
   * The agent's public key. Pairing links and the QR code carry it already;
   * this is for typing an address and a code by hand, where the app may only
   * fetch it over HTTPS or from localhost (so TLS or the port-forward
   * vouches for it, once, at pairing). Public by nature.
   */
  identityKey(): { publicKey: string; fingerprint: string } {
    return { publicKey: this.identity.publicKey, fingerprint: this.identity.fingerprint };
  }

  /** Every API call of the app: see E2eService and docs/PROTOCOL.md. */
  async call(raw: Buffer | undefined, remoteAddress: string | undefined): Promise<Reply> {
    const body = raw ? new Uint8Array(raw) : new Uint8Array(0);
    // The socket's own address: X-Forwarded-For is whatever the caller writes.
    const result = await this.e2e.handle(body, Date.now(), 'direct', remoteAddress);
    if (result.kind === 'plain') {
      return new Reply(result.status, JSON.stringify({ code: result.code }), 'application/json; charset=utf-8');
    }
    return new Reply(200, Buffer.from(result.body), 'application/octet-stream');
  }
}

export function e2eRoutes(c: E2eApi): Route[] {
  return [
    { method: 'GET', path: '/api/identity', public: true, handle: () => c.identityKey() },
    {
      method: 'POST',
      path: '/api/e2e',
      public: true,
      raw: true,
      handle: (r) => c.call(r.raw, r.req.socket.remoteAddress),
    },
  ];
}
