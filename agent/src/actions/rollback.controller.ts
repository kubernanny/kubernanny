import { Body, Controller, HttpCode, Inject, Post } from '@nestjs/common';
import type { Principal } from '../auth/devices.service';
import { CurrentPrincipal } from '../auth/principal.guard';
import type { Text } from '../i18n/text';
import { RollbackRequest, RollbackService } from './rollback.service';

/** `POST /api/argocd/rollback { namespace, app, id }` (docs/API.md); off unless the deployment opts in. */
@Controller('argocd')
export class RollbackController {
  constructor(@Inject(RollbackService) private readonly rollbacks: RollbackService) {}

  @Post('rollback')
  @HttpCode(200)
  async rollback(@Body() body: RollbackRequest, @CurrentPrincipal() who: Principal): Promise<{ done: Text; revision: string }> {
    return this.rollbacks.rollback(body ?? {}, who);
  }
}
