import { BadRequestException, NotFoundException } from '../../http/errors';
import type { Route } from '../../http/server';
import type { Principal } from '../../auth/devices.service';
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
export class AcceptanceController {
  constructor(
    private readonly acceptance: AcceptanceService,
    private readonly status: StatusService,
  ) {}

  async accept(body: AcceptBody, who: Principal): Promise<{ acceptedUntil: string }> {
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

  async unaccept(body: AcceptBody, who: Principal): Promise<void> {
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

export function acceptanceRoutes(c: AcceptanceController): Route[] {
  return [
    { method: 'POST', path: '/api/vulnerabilities/accept', handle: (r) => c.accept(r.body as AcceptBody, r.principal) },
    { method: 'POST', path: '/api/vulnerabilities/unaccept', status: 204, handle: (r) => c.unaccept(r.body as AcceptBody, r.principal) },
  ];
}
