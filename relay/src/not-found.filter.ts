import { ArgumentsHost, Catch, ExceptionFilter, NotFoundException } from '@nestjs/common';
import type { Response } from 'express';
import { relayError } from './core/http';

/** Unknown routes answer like every other relay refusal (and like the Worker), not with Nest's default body. */
@Catch(NotFoundException)
export class RelayNotFoundFilter implements ExceptionFilter {
  catch(_exception: NotFoundException, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<Response>();
    const { status, body } = relayError('RELAY_NOT_FOUND');
    res.status(status).type('application/json').send(body);
  }
}
