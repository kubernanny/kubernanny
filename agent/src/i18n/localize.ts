import { ArgumentsHost, CallHandler, Catch, ExceptionFilter, ExecutionContext, HttpException, Inject, Injectable, NestInterceptor } from '@nestjs/common';
import type { Request, Response } from 'express';
import { Observable, map } from 'rxjs';
import { INTERNAL, LANGUAGE_HEADER } from '../auth/principal.guard';
import { CONFIG, Config } from '../config';
import { Lang, localize, resolveLang } from './text';

/**
 * The language of one request: the header the end-to-end channel sets from
 * the sealed request (only believed on the internal socket, like the
 * principal), else the agent's default (`LANGUAGE`).
 */
export function requestLang(req: Request, fallback: Lang): Lang {
  const internal = (req as Request & { [INTERNAL]?: true })[INTERNAL] === true;
  return internal ? resolveLang(req.headers[LANGUAGE_HEADER], fallback) : fallback;
}

/** Renders every Text in a response body in the request's language, at the very edge. */
@Injectable()
export class LocalizeInterceptor implements NestInterceptor {
  constructor(@Inject(CONFIG) private readonly config: Config) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const lang = requestLang(context.switchToHttp().getRequest<Request>(), this.config.language);
    return next.handle().pipe(map((body: unknown) => localize(body, lang)));
  }
}

/** The same for error bodies: `{ code, message }` with `message` in the request's language. */
@Catch(HttpException)
export class LocalizeExceptionFilter implements ExceptionFilter {
  constructor(@Inject(CONFIG) private readonly config: Config) {}

  catch(exception: HttpException, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const lang = requestLang(http.getRequest<Request>(), this.config.language);
    const status = exception.getStatus();
    const body = exception.getResponse();
    // Nest's own shape for a plain string message, so nothing changes for the routes that throw one.
    http.getResponse<Response>().status(status).json(typeof body === 'string' ? { statusCode: status, message: body } : localize(body, lang));
  }
}
