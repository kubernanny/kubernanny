import { Controller, Get, Inject, Logger, Options, Param, Post, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { AgentHub } from './agent-hub.service';
import { RelayErrorCode, corsHeaders, idPrefix, parseRoute, relayError } from './core/http';
import { RELAY_CONFIG, RelayConfig } from './config';
import { RelayMetrics, outcomeOf } from './metrics';

/**
 * The app's side: `POST /v1/agents/{agentId}/e2e` with the sealed body the
 * app would send to the agent's own `/api/e2e`. The answer comes back with
 * the same status semantics: 200 and the sealed answer, or the agent's
 * plain refusal (`{"code": "E2E_…"}`), or the relay's own (`RELAY_…`).
 */
@Controller()
export class RelayController {
  private readonly logger = new Logger('relay');

  constructor(
    @Inject(AgentHub) private readonly hub: AgentHub,
    @Inject(RelayMetrics) private readonly metrics: RelayMetrics,
    @Inject(RELAY_CONFIG) private readonly config: RelayConfig,
  ) {}

  @Get('healthz')
  health(): { ok: true } {
    return { ok: true };
  }

  @Options('v1/agents/:agentId/e2e')
  preflight(@Req() req: Request, @Res() res: Response): void {
    res.set(corsHeaders(req.headers.origin, this.config.limits.corsOrigins)).status(204).end();
  }

  @Post('v1/agents/:agentId/e2e')
  async call(@Param('agentId') agentId: string, @Req() req: Request, @Res() res: Response): Promise<void> {
    const started = Date.now();
    res.set(corsHeaders(req.headers.origin, this.config.limits.corsOrigins));
    res.set('cache-control', 'no-store');
    const route = parseRoute(`/v1/agents/${agentId}/e2e`);
    if (route?.kind !== 'call') {
      return this.refuse(res, 'RELAY_NOT_FOUND', agentId, 0, started);
    }
    const body = await readBody(req, this.config.limits.maxRequestBytes);
    if (body === 'too large') {
      return this.refuse(res, 'RELAY_TOO_LARGE', agentId, 0, started);
    }
    if (body === null || body.length === 0) {
      return this.refuse(res, 'RELAY_BAD_REQUEST', agentId, 0, started);
    }
    const result = await this.hub.call(route.agentId, body);
    if (result.kind === 'error') {
      return this.refuse(res, result.code, agentId, body.length, started);
    }
    const ms = Date.now() - started;
    this.metrics.call(outcomeOf(null, result.status), body.length, result.body.length, ms);
    this.logger.debug(`call ${idPrefix(agentId)} ${result.status} in=${body.length} out=${result.body.length} ${ms}ms`);
    res
      .status(result.status)
      .type(result.status === 200 ? 'application/octet-stream' : 'application/json')
      .send(Buffer.from(result.body.buffer, result.body.byteOffset, result.body.byteLength));
  }

  private refuse(res: Response, code: RelayErrorCode, agentId: string, bytesIn: number, started: number): void {
    const { status, body } = relayError(code);
    const ms = Date.now() - started;
    this.metrics.call(outcomeOf(code, status), bytesIn, 0, ms);
    this.logger.debug(`call ${idPrefix(agentId)} ${code} in=${bytesIn} ${ms}ms`);
    if (!res.headersSent) {
      res.status(status).type('application/json').send(body);
    }
  }
}

/** The raw body, at most `limit` bytes; stops reading (and says so) past it. */
function readBody(req: Request, limit: number): Promise<Uint8Array | 'too large' | null> {
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > limit) {
    req.resume();
    return Promise.resolve('too large');
  }
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    req.on('data', (chunk: Buffer) => {
      if (done) {
        return;
      }
      size += chunk.length;
      if (size > limit) {
        done = true;
        resolve('too large');
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!done) {
        done = true;
        resolve(new Uint8Array(Buffer.concat(chunks)));
      }
    });
    req.on('error', () => {
      if (!done) {
        done = true;
        resolve(null);
      }
    });
  });
}
