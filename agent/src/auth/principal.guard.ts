import { CanActivate, ExecutionContext, Inject, Injectable, SetMetadata, UnauthorizedException, createParamDecorator } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { CONFIG, Config } from '../config';
import { t } from '../i18n/text';
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

type InternalRequest = Request & { [INTERNAL]?: true; principal?: Principal };

export const IS_PUBLIC = 'kubernanny:public';
/**
 * A route anyone on the network may call, without a device: only /healthz,
 * /api/identity and /api/e2e. Every other route is guarded by default
 * (PrincipalGuard is the global APP_GUARD), so a new one fails closed.
 */
export const Public = () => SetMetadata(IS_PUBLIC, true);

/**
 * The global guard. Requests on the public port never pass a guarded route:
 * the app reaches them only through the end-to-end channel, which hands them
 * in over the internal socket after the handshake proved the device.
 */
@Injectable()
export class PrincipalGuard implements CanActivate {
  constructor(
    @Inject(DevicesService) private readonly devices: DevicesService,
    @Inject(CONFIG) private readonly config: Config,
    @Inject(Reflector) private readonly reflector: Reflector,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [context.getHandler(), context.getClass()])) {
      return true;
    }
    const req = context.switchToHttp().getRequest<InternalRequest>();
    const principal = req[INTERNAL] === true ? this.resolve(req.headers[PRINCIPAL_HEADER]) : null;
    if (!principal) {
      throw new UnauthorizedException({ code: 'E2E_REQUIRED', message: t('error.e2eRequired') });
    }
    req.principal = principal;
    return true;
  }

  private resolve(header: string | string[] | undefined): Principal | null {
    if (header === 'admin') {
      return ADMIN;
    }
    if (header === 'demo') {
      return this.config.demo ? DEMO_DEVICE : null;
    }
    return typeof header === 'string' ? this.devices.byId(header) : null;
  }
}

/** The device (or the admin CLI) behind the request; set by PrincipalGuard. */
export const CurrentPrincipal = createParamDecorator((_: unknown, ctx: ExecutionContext): Principal => {
  return ctx.switchToHttp().getRequest<InternalRequest>().principal!;
});
