import { BadRequestException, Body, Controller, HttpCode, Inject, NotFoundException, Post } from '@nestjs/common';
import type { Principal } from '../../auth/devices.service';
import { CurrentPrincipal } from '../../auth/principal.guard';
import { t } from '../../i18n/text';
import { StatusService } from '../../status/status.service';
import { acceptComponentOfIssue } from './acceptance';
import { AcceptanceService } from './acceptance.service';

interface AcceptBody {
  component?: unknown;
  advisory?: unknown;
  days?: unknown;
  reason?: unknown;
}

/** Marks one advisory on one component as not applicable, and takes that back (docs/API.md). */
@Controller('vulnerabilities')
export class AcceptanceController {
  constructor(
    @Inject(AcceptanceService) private readonly acceptance: AcceptanceService,
    @Inject(StatusService) private readonly status: StatusService,
  ) {}

  @Post('accept')
  @HttpCode(200)
  async accept(@Body() body: AcceptBody, @CurrentPrincipal() who: Principal): Promise<{ acceptedUntil: string }> {
    // Locked in Helm or the module switched off: refused before anything is read or written.
    this.acceptance.assertAllowed();
    const { component, advisory } = this.target(body);
    // Only what the agent reports right now, so nobody pre-accepts advisories that are not there yet.
    const reported = this.status.snapshot().issues.some((i) => (i.check === 'vulnerabilities' || i.check === 'trivy') && acceptComponentOfIssue(i.id) === component && i.advisories?.includes(advisory));
    if (!reported) {
      throw new NotFoundException({ code: 'ADVISORY_NOT_FOUND', message: t('error.advisoryNotFound') });
    }
    const acceptedUntil = await this.acceptance.accept(component, advisory, typeof body.days === 'number' ? body.days : NaN, body.reason, who);
    await this.status.refreshAfterChange();
    return { acceptedUntil };
  }

  @Post('unaccept')
  @HttpCode(204)
  async unaccept(@Body() body: AcceptBody, @CurrentPrincipal() who: Principal): Promise<void> {
    this.acceptance.assertAllowed();
    const { component, advisory } = this.target(body);
    await this.acceptance.unaccept(component, advisory, who);
    await this.status.refreshAfterChange();
  }

  private target(body: AcceptBody): { component: string; advisory: string } {
    if (typeof body !== 'object' || body === null || typeof body.component !== 'string' || typeof body.advisory !== 'string') {
      throw new BadRequestException({ code: 'ACCEPT_TARGET', message: t('error.acceptTarget') });
    }
    return { component: body.component, advisory: body.advisory };
  }
}
