import type { IncomingMessage } from 'node:http';

import { INTERNAL, LANGUAGE_HEADER } from '../auth/principal';
import { Lang, resolveLang } from './text';

/**
 * The language of one request: the header the end-to-end channel sets from
 * the sealed request (only believed on the internal socket, like the
 * principal), else the agent's default (`LANGUAGE`). Every Text in a
 * response body, success or error, is rendered in it at the very edge
 * (`http/server.ts`).
 */
export function requestLang(req: IncomingMessage, fallback: Lang): Lang {
  const internal = (req as IncomingMessage & { [INTERNAL]?: true })[INTERNAL] === true;
  return internal ? resolveLang(req.headers[LANGUAGE_HEADER], fallback) : fallback;
}
