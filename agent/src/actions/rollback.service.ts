import type { Principal } from '../auth/devices.service';
import { ArgoApplication } from '../checks/argocd.check';
import { rollbackTarget, shortRevision } from '../checks/argocd-rollback';
import { BadRequestError, ConflictError, ForbiddenError, HttpError, HttpStatus, NotFoundError } from '../http/errors';
import { t, Text } from '../i18n/text';
import { KubeClient, KubeError } from '../kube/kube-client';
import { Logger } from '../logger';
import { Notifier } from '../notify/notifier';
import { SettingsService } from '../settings/settings.service';
import { StatusService } from '../status/status.service';
import { logSafe } from '../util/log-safe';

/** A Kubernetes object name or namespace (RFC 1123 label/subdomain), as the request names it. */
const NAME = /^[a-z0-9]([-a-z0-9.]{0,251}[a-z0-9])?$/;
/** One rollback per app at most this often: a stolen device cannot flap an app back and forth. */
export const ROLLBACK_INTERVAL_MS = 5 * 60_000;

export interface RollbackRequest {
  namespace?: unknown;
  app?: unknown;
  id?: unknown;
}

/**
 * Rolls a manual-sync, single-source Argo CD app back to an earlier entry of
 * its own `status.history` (`argocd-rollback`, opt-in through Helm
 * `actions.enabled`). The request names only the app and the history id;
 * the revision comes from the agent's own read of the Application, and the
 * patch never names a source, so the app's `spec.source` is synced at that
 * revision and nothing else. Every rollback is announced before it is sent.
 */
export class RollbackService {
  private readonly audit = new Logger('audit');
  /** "namespace/app" to the time of its last rollback (ms). In memory: a restart forgets it, which costs at most one extra rollback. */
  private readonly last = new Map<string, number>();

  constructor(
    private readonly kube: KubeClient,
    private readonly settings: SettingsService,
    private readonly status: StatusService,
    private readonly notifier?: Notifier,
  ) {}

  /** Before anything is read: off (not opted in, disabled, or switched off in the app) or Argo CD not checked. */
  assertAllowed(): void {
    if (!this.settings.actionOn('argocd-rollback')) {
      throw new ForbiddenError({ code: 'ACTION_DISABLED', message: t('error.actionDisabled') });
    }
    if (!this.settings.moduleOn('argocd')) {
      throw new ForbiddenError({ code: 'MODULE_OFF', message: t('error.argocdOff') });
    }
  }

  async rollback(body: RollbackRequest, who: Principal, now = Date.now()): Promise<{ done: Text; revision: string }> {
    this.assertAllowed();
    const { namespace, app, id } = target(body);
    const key = `${namespace}/${app}`;
    const previous = this.last.get(key);
    if (previous !== undefined && now - previous < ROLLBACK_INTERVAL_MS) {
      throw new HttpError(
        { code: 'ROLLBACK_RATE_LIMITED', message: t('error.rollbackRateLimited') },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    const path = `/apis/argoproj.io/v1alpha1/namespaces/${encodeURIComponent(namespace)}/applications/${encodeURIComponent(app)}`;
    let application: ArgoApplication;
    try {
      application = await this.kube.get<ArgoApplication>(path);
    } catch (err) {
      if (err instanceof KubeError && err.status === 404) {
        throw new NotFoundError({ code: 'APP_NOT_FOUND', message: t('error.rollbackAppNotFound') });
      }
      throw err;
    }
    const decided = rollbackTarget(application, id);
    if ('refusal' in decided) {
      throw new ConflictError({ code: decided.refusal, message: t(`error.${decided.refusal}`) });
    }
    const from = application.status?.sync?.revision;
    const fromShort = typeof from === 'string' ? shortRevision(logSafe(from, 64)) : '?';
    const toShort = shortRevision(decided.revision);
    // Taken before the alert and the patch, so two requests at once cannot both pass.
    this.last.set(key, now);
    // Before it takes effect, like every security-relevant change; never blocks it (securityAlert does not throw).
    await this.notifier?.securityAlert(who.name, [{ kind: 'rolledBack', app: key, from: fromShort, to: toShort }]);
    this.audit.log(
      `argocd-rollback by "${who.name}" (${who.id}) on ${key}: ${logSafe(from ?? '-', 64)} -> ${decided.revision} (history id ${id})`,
    );
    await this.kube.mergePatch(path, {
      operation: {
        initiatedBy: { username: 'kubernanny' },
        info: [{ name: 'Reason', value: 'Rollback from the Kubernanny app' }],
        sync: { revision: decided.revision, syncStrategy: { hook: {} } },
      },
    });
    void this.status.refresh();
    return { done: t('action.done.rollback', { app, revision: toShort }), revision: decided.revision };
  }
}

function target(body: RollbackRequest): { namespace: string; app: string; id: number } {
  const ok =
    typeof body === 'object' &&
    body !== null &&
    typeof body.namespace === 'string' &&
    NAME.test(body.namespace) &&
    typeof body.app === 'string' &&
    NAME.test(body.app) &&
    typeof body.id === 'number' &&
    Number.isSafeInteger(body.id) &&
    body.id >= 0;
  if (!ok) {
    throw new BadRequestError({ code: 'ROLLBACK_TARGET', message: t('error.rollbackTarget') });
  }
  return { namespace: body.namespace as string, app: body.app as string, id: body.id as number };
}
