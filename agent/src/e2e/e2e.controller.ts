import { Controller, Get, HttpCode, Inject, Post, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { IdentityService } from '../auth/identity.service';
import { Public } from '../auth/principal.guard';
import { E2eService } from './e2e.service';

/** Public by design: the identity is a public key, and /e2e authenticates every call itself (E2eService). */
@Public()
@Controller()
export class E2eController {
  constructor(
    @Inject(E2eService) private readonly e2e: E2eService,
    @Inject(IdentityService) private readonly identity: IdentityService,
  ) {}

  /**
   * The agent's public key. Pairing links and the QR code carry it already;
   * this is for typing an address and a code by hand, where the app may only
   * fetch it over HTTPS or from localhost (so TLS or the port-forward
   * vouches for it, once, at pairing). Public by nature.
   */
  @Get('identity')
  identityKey(): { publicKey: string; fingerprint: string } {
    return { publicKey: this.identity.publicKey, fingerprint: this.identity.fingerprint };
  }

  /** Every API call of the app: see E2eService and docs/PROTOCOL.md. */
  @Post('e2e')
  @HttpCode(200)
  async call(@Req() req: Request, @Res() res: Response): Promise<void> {
    const body = Buffer.isBuffer(req.body) ? new Uint8Array(req.body) : new Uint8Array(0);
    // The socket's own address: X-Forwarded-For is whatever the caller writes.
    const result = await this.e2e.handle(body, Date.now(), 'direct', req.socket.remoteAddress);
    if (result.kind === 'plain') {
      res.status(result.status).json({ code: result.code });
      return;
    }
    res.status(200).type('application/octet-stream').send(Buffer.from(result.body));
  }
}
