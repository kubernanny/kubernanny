import type { Route } from '../http/server';
import type { Principal } from '../auth/devices.service';
import type { Text } from '../i18n/text';
import { RollbackRequest, RollbackService } from './rollback.service';

/** `POST /api/argocd/rollback { namespace, app, id }` (docs/API.md); off unless the deployment opts in. */
export class RollbackApi {
  constructor(private readonly rollbacks: RollbackService) {}

  async rollback(body: RollbackRequest, who: Principal): Promise<{ done: Text; revision: string }> {
    return this.rollbacks.rollback(body ?? {}, who);
  }
}

export function rollbackRoutes(c: RollbackApi): Route[] {
  return [{ method: 'POST', write: true, path: '/api/argocd/rollback', handle: (r) => c.rollback(r.body as RollbackRequest, r.principal) }];
}
