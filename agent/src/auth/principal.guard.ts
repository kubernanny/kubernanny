import type { IncomingMessage } from 'node:http';
import type { Config } from '../config';
import { ADMIN, DEMO_DEVICE, DevicesService, Principal } from './devices.service';

/**
 * Set on a request only by the agent's internal server (a Unix socket inside
 * the pod). A symbol property cannot arrive over the network: no header, no
 * body, no proxy can set it.
 */
export const INTERNAL = Symbol('kubernanny.internal');
/** Who the internal request is for: a device id, "admin" or "demo". Only read when INTERNAL is set. */
export const PRINCIPAL_HEADER = 'x-kubernanny-principal';
/** The app's language for the texts in the answer, from the sealed request (`l`). Only read when INTERNAL is set. */
export const LANGUAGE_HEADER = 'x-kubernanny-language';

export type InternalRequest = IncomingMessage & { [INTERNAL]?: true };

/**
 * The guard in front of every route that is not public (`public: true` in the
 * route table: only /healthz, /readyz, /api/identity and /api/e2e). Requests
 * on the public port never pass it: the app reaches the other routes only
 * through the end-to-end channel, which hands them in over the internal
 * socket after the handshake proved the device. Null: answer 401.
 */
export function principalOf(req: InternalRequest, devices: DevicesService, config: Config): Principal | null {
  if (req[INTERNAL] !== true) {
    return null;
  }
  const header = req.headers[PRINCIPAL_HEADER];
  if (header === 'admin') {
    return ADMIN;
  }
  if (header === 'demo') {
    return config.demo ? DEMO_DEVICE : null;
  }
  return typeof header === 'string' ? devices.byId(header) : null;
}
