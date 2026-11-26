import type { Principal } from '../auth/devices.service';
import {
  appSyncOptions,
  pruneResources,
  REPLACE,
  resourceKey,
  SERVER_SIDE_APPLY,
  SYNC_PRUNE_LIMIT,
} from '../checks/argocd-sync-offer';
import { Condition, IssueAction, IssueActionType, ReconcileKind, SyncOptions, WorkloadKind } from '../checks/types';
import { BadRequestError, ConflictError, ForbiddenError, NotFoundError } from '../http/errors';
import { t, Text } from '../i18n/text';
import { KubeClient, KubeError } from '../kube/kube-client';
import { Logger } from '../logger';
import { RERUN_LABEL } from '../modules/core/workloads';
import { SettingsService } from '../settings/settings.service';
import { StatusService } from '../status/status.service';
import { logSafe } from '../util/log-safe';
import { PodTemplateRisk, riskyPodTemplate } from './pod-security';

const WORKLOAD_PATH: Record<WorkloadKind, string> = {
  Deployment: 'deployments',
  StatefulSet: 'statefulsets',
  DaemonSet: 'daemonsets',
};

/** Where each kind `reconcile-now` handles lives, and the annotation its controller reconciles on. */
const RECONCILE: Record<
  Exclude<ReconcileKind, 'Certificate'>,
  { path: string; annotation: string; value: () => string }
> = {
  // flux reconcile: any new value of requestedAt makes the controller reconcile at once.
  Kustomization: {
    path: '/apis/kustomize.toolkit.fluxcd.io/v1/namespaces/{ns}/kustomizations/{name}',
    annotation: 'reconcile.fluxcd.io/requestedAt',
    value: () => new Date().toISOString(),
  },
  HelmRelease: {
    path: '/apis/helm.toolkit.fluxcd.io/v2/namespaces/{ns}/helmreleases/{name}',
    annotation: 'reconcile.fluxcd.io/requestedAt',
    value: () => new Date().toISOString(),
  },
  // External Secrets FAQ: `kubectl annotate es <name> force-sync=$(date +%s) --overwrite`.
  ExternalSecret: {
    path: '/apis/external-secrets.io/v1/namespaces/{ns}/externalsecrets/{name}',
    annotation: 'force-sync',
    value: () => String(Math.floor(Date.now() / 1000)),
  },
  // The Infisical operator (v1beta1 controller) reconciles an InfisicalStaticSecret on any change of its annotations.
  InfisicalStaticSecret: {
    path: '/apis/secrets.infisical.com/v1beta1/namespaces/{ns}/infisicalstaticsecrets/{name}',
    annotation: 'kubernanny.io/requested-at',
    value: () => new Date().toISOString(),
  },
};

/** Labels the Job controller sets from the Job's uid: a copy must not carry them, or its selector would match the old pods. */
const JOB_CONTROLLER_LABELS = [
  'controller-uid',
  'batch.kubernetes.io/controller-uid',
  'job-name',
  'batch.kubernetes.io/job-name',
];

const CREATED_BY = { 'app.kubernetes.io/created-by': 'kubernanny' };

/** Fields of a Velero backup spec the admission policy denies to the agent; a schedule using them is not backed up from the app. */
const VELERO_REFUSED = ['hooks', 'resourcePolicy', 'orderedResources'] as const;

const enc = encodeURIComponent;

/** "prune (2), Server-Side Apply, Replace": Argo CD's own names, in the audit log and the confirmation toast. */
function describeOptions(o: SyncOptions): string {
  return [
    o.prune?.length ? `prune (${o.prune.length})` : null,
    o.serverSideApply ? 'Server-Side Apply' : null,
    o.replace ? 'Replace' : null,
  ]
    .filter(Boolean)
    .join(', ');
}
/** The newest part of a pod's log the app shows: Kubernetes cuts it (`limitBytes`), and the client refuses anything larger. */
export const LOG_LIMIT_BYTES = 256 * 1024;

/**
 * Runs an action of an issue the agent currently sees. The request only names
 * the issue and the action type; namespace, name and kind come from the
 * agent's own check result, so a stolen device key cannot restart arbitrary
 * workloads, only the ones that are broken right now.
 */
export class ActionsService {
  private readonly logger = new Logger(ActionsService.name);

  constructor(
    private readonly kube: KubeClient,
    private readonly status: StatusService,
    private readonly settings: SettingsService,
  ) {}

  find(issueId: string, type: IssueActionType, index = 0): IssueAction {
    // The snapshot drops switched-off actions too; this covers the moment between a switch and the next run.
    if (!this.settings.actionOn(type)) {
      throw new ForbiddenError({ code: 'ACTION_DISABLED', message: t('error.actionDisabled') });
    }
    const issue = this.status.findIssue(issueId);
    if (!issue) {
      throw new ConflictError({ code: 'ISSUE_GONE', message: t('error.issueGone') });
    }
    const action = issue.actions.filter((a) => a.type === type)[index];
    if (!action) {
      throw new NotFoundError({ code: 'ACTION_NOT_OFFERED', message: t('error.actionNotOffered', { type }) });
    }
    return action;
  }

  async run(
    issueId: string,
    type: IssueActionType,
    index = 0,
    who?: Principal,
    options?: SyncOptions,
  ): Promise<{ done: Text }> {
    const action = this.find(issueId, type, index);
    const chosen = this.checkOptions(action, options);
    // The audit trail: who ran what on which object, and with which sync options.
    const { offer: _offer, ...target } = action as IssueAction & { offer?: unknown };
    this.logger.log(
      `action ${type} by "${who?.name ?? 'unknown'}" (${who?.id ?? '-'}) on ${logSafe(issueId)}: ${JSON.stringify(target)}${
        chosen ? ` options: ${logSafe(JSON.stringify(chosen), 4000)}` : ''
      }`,
    );
    let done: Text;
    switch (action.type) {
      case 'argocd-sync':
        done = await this.sync(action, chosen);
        break;
      case 'argocd-refresh':
        await this.kube.mergePatch(
          `/apis/argoproj.io/v1alpha1/namespaces/${enc(action.namespace)}/applications/${enc(action.app)}`,
          {
            metadata: { annotations: { 'argocd.argoproj.io/refresh': 'hard' } },
          },
        );
        done = t('action.done.refresh', { app: action.app });
        break;
      case 'restart':
        await this.kube.mergePatch(
          `/apis/apps/v1/namespaces/${enc(action.namespace)}/${WORKLOAD_PATH[action.kind]}/${enc(action.name)}`,
          {
            spec: {
              template: {
                metadata: { annotations: { 'kubectl.kubernetes.io/restartedAt': new Date().toISOString() } },
              },
            },
          },
        );
        done = t('action.done.restart', { kind: action.kind, name: action.name });
        break;
      case 'cnpg-backup':
        await this.kube.create(`/apis/postgresql.cnpg.io/v1/namespaces/${enc(action.namespace)}/backups`, {
          apiVersion: 'postgresql.cnpg.io/v1',
          kind: 'Backup',
          metadata: {
            generateName: `${action.cluster}-kubernanny-`,
            labels: { 'app.kubernetes.io/created-by': 'kubernanny' },
          },
          spec: { cluster: { name: action.cluster } },
        });
        done = t('action.done.backup', { cluster: action.cluster });
        break;
      case 'uncordon':
        await this.kube.mergePatch(`/api/v1/nodes/${enc(action.node)}`, { spec: { unschedulable: false } });
        done = t('action.done.uncordon', { node: action.node });
        break;
      case 'job-rerun':
        done = await this.rerunJob(action);
        break;
      case 'reconcile-now':
        done = await this.reconcile(action);
        break;
      case 'cleanup-pods': {
        let deleted = 0;
        for (const pod of action.pods) {
          // A pod gone meanwhile is fine; the admission policy refuses one that is not finished.
          await this.kube.delete(`/api/v1/namespaces/${enc(action.namespace)}/pods/${enc(pod)}`).then(
            () => deleted++,
            (err: unknown) => {
              if (!(err instanceof KubeError && err.status === 404)) {
                throw err;
              }
            },
          );
        }
        done = t('action.done.cleanupPods', { n: deleted, namespace: action.namespace });
        break;
      }
      case 'force-delete-terminating':
        await this.kube.delete(`/api/v1/namespaces/${enc(action.namespace)}/pods/${enc(action.pod)}`, {
          gracePeriodSeconds: 0,
        });
        done = t('action.done.forceDelete', { pod: action.pod });
        break;
      case 'longhorn-backup': {
        // Longhorn's CR way: a Snapshot, then a Backup of it (the backup controller waits for the snapshot to be ready).
        const name = `kubernanny-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
        const base = `/apis/longhorn.io/v1beta2/namespaces/${enc(action.namespace)}`;
        await this.kube.create(`${base}/snapshots`, {
          apiVersion: 'longhorn.io/v1beta2',
          kind: 'Snapshot',
          metadata: { name, labels: { ...CREATED_BY, longhornvolume: action.volume } },
          spec: { volume: action.volume, createSnapshot: true },
        });
        await this.kube.create(`${base}/backups`, {
          apiVersion: 'longhorn.io/v1beta2',
          kind: 'Backup',
          metadata: { name, labels: { ...CREATED_BY, 'backup-volume': action.volume } },
          spec: { snapshotName: name },
        });
        done = t('action.done.longhornBackup', { volume: action.label });
        break;
      }
      case 'velero-backup': {
        const base = `/apis/velero.io/v1/namespaces/${enc(action.namespace)}`;
        const schedule = await this.kube.get<{
          spec?: { template?: Record<string, unknown> & { metadata?: { labels?: Record<string, string> } } };
        }>(`${base}/schedules/${enc(action.schedule)}`);
        const { metadata: templateMeta, ...spec } = schedule.spec?.template ?? {};
        // Hooks run commands in pods, a resource policy and an order steer what is read: the admission policy
        // cannot compare them with the schedule, so it denies them, and a schedule using them is not backed up from here.
        const refused = VELERO_REFUSED.filter((field) => spec[field] !== undefined);
        if (refused.length > 0) {
          throw new ConflictError({
            code: 'VELERO_HOOKS',
            message: t('error.veleroHooks', { schedule: action.schedule, fields: refused.join(', ') }),
          });
        }
        // As `velero backup create --from-schedule`: the schedule's template, named <schedule>-<timestamp>, labelled with the schedule.
        const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
        await this.kube.create(`${base}/backups`, {
          apiVersion: 'velero.io/v1',
          kind: 'Backup',
          metadata: {
            name: `${action.schedule}-${stamp}`,
            labels: { ...(templateMeta?.labels ?? {}), ...CREATED_BY, 'velero.io/schedule-name': action.schedule },
          },
          spec,
        });
        done = t('action.done.veleroBackup', { schedule: action.schedule });
        break;
      }
      case 'argocd-terminate-op': {
        const path = `/apis/argoproj.io/v1alpha1/namespaces/${enc(action.namespace)}/applications/${enc(action.app)}`;
        const app = await this.kube.get<{
          metadata?: { resourceVersion?: string };
          status?: { operationState?: { phase?: string } };
        }>(path);
        if (app.status?.operationState?.phase !== 'Running') {
          throw new ConflictError({ code: 'TARGET_CHANGED', message: t('error.targetChanged') });
        }
        // What `argocd app terminate-op` asks the API server to do: the controller sees Terminating and stops the sync.
        await this.kube.mergePatch(path, {
          metadata: { resourceVersion: app.metadata?.resourceVersion },
          status: { operationState: { phase: 'Terminating' } },
        });
        done = t('action.done.terminateOp', { app: action.app });
        break;
      }
      case 'pvc-expand': {
        const path = `/api/v1/namespaces/${enc(action.namespace)}/persistentvolumeclaims/${enc(action.name)}`;
        const pvc = await this.kube.get<{
          metadata?: { resourceVersion?: string };
          spec?: { resources?: { requests?: { storage?: string } } };
        }>(path);
        // Grown by someone else meanwhile: growing again from the old number would be a surprise.
        if (pvc.spec?.resources?.requests?.storage !== action.from) {
          throw new ConflictError({ code: 'TARGET_CHANGED', message: t('error.targetChanged') });
        }
        await this.kube.mergePatch(path, {
          metadata: { resourceVersion: pvc.metadata?.resourceVersion },
          spec: { resources: { requests: { storage: action.to } } },
        });
        done = t('action.done.pvcExpand', { pvc: `${action.namespace}/${action.name}`, size: action.to });
        break;
      }
      case 'logs':
        throw new BadRequestError({ code: 'USE_LOGS_ROUTE', message: t('error.useLogsRoute') });
    }
    void this.status.refresh();
    return { done };
  }

  /**
   * Which sync options are wanted, checked against the issue's offer and the
   * switches; undefined for a plain sync. Prune and Replace each have their
   * own switch, so a device that may sync cannot delete or replace with it.
   */
  private checkOptions(action: IssueAction, options: SyncOptions | undefined): SyncOptions | undefined {
    const prune = options?.prune ?? [];
    const wanted = prune.length > 0 || options?.serverSideApply === true || options?.replace === true;
    if (!wanted) {
      return undefined;
    }
    if (action.type !== 'argocd-sync') {
      throw new BadRequestError({ code: 'OPTIONS_UNSUPPORTED', message: t('error.optionsUnsupported') });
    }
    const offer = action.offer;
    if (prune.length > 0) {
      if (!this.settings.actionOn('argocd-sync-prune')) {
        throw new ForbiddenError({ code: 'ACTION_DISABLED', message: t('error.actionDisabled') });
      }
      if (!offer || offer.prune.length === 0 || offer.pruneMore || prune.length > SYNC_PRUNE_LIMIT) {
        throw new NotFoundError({
          code: 'OPTION_NOT_OFFERED',
          message: t('error.optionNotOffered', { option: 'prune' }),
        });
      }
    }
    if (options?.replace === true) {
      if (!this.settings.actionOn('argocd-sync-replace')) {
        throw new ForbiddenError({ code: 'ACTION_DISABLED', message: t('error.actionDisabled') });
      }
      if (!offer?.failure || offer.failure.kind === 'immutable') {
        throw new NotFoundError({
          code: 'OPTION_NOT_OFFERED',
          message: t('error.optionNotOffered', { option: 'Replace' }),
        });
      }
    }
    return {
      ...(prune.length > 0 ? { prune } : {}),
      ...(options?.serverSideApply === true ? { serverSideApply: true } : {}),
      ...(options?.replace === true ? { replace: true } : {}),
    };
  }

  /**
   * A sync as Argo CD's own Sync button starts it: with the app's own sync
   * options (an operation written with kubectl does not get them by itself,
   * so without this an app set to Server-Side Apply was synced client-side),
   * plus the options chosen. With prune the resources Argo CD would delete
   * must be exactly the ones the person confirmed, read now and bound to this
   * version of the Application.
   */
  private async sync(action: Extract<IssueAction, { type: 'argocd-sync' }>, chosen?: SyncOptions): Promise<Text> {
    const path = `/apis/argoproj.io/v1alpha1/namespaces/${enc(action.namespace)}/applications/${enc(action.app)}`;
    const app = await this.kube.get<Parameters<typeof appSyncOptions>[0] & { metadata: { resourceVersion?: string } }>(
      path,
    );
    let own = appSyncOptions(app);
    if (chosen?.serverSideApply) {
      own = own.filter((o) => !o.startsWith('ServerSideApply='));
    }
    const syncOptions = [
      ...new Set([
        ...own,
        ...(chosen?.serverSideApply ? [SERVER_SIDE_APPLY] : []),
        ...(chosen?.replace ? [REPLACE] : []),
      ]),
    ];
    const prune = (chosen?.prune ?? []).length > 0;
    if (prune) {
      const now = pruneResources(app).map(resourceKey).sort();
      const confirmed = [...new Set(chosen!.prune)].sort();
      if (now.length === 0 || now.join('\n') !== confirmed.join('\n')) {
        throw new ConflictError({ code: 'TARGET_CHANGED', message: t('error.pruneChanged') });
      }
    }
    await this.kube.mergePatch(path, {
      // With prune: only this version of the Application, whose list of resources to delete was just compared.
      ...(prune ? { metadata: { resourceVersion: app.metadata.resourceVersion } } : {}),
      operation: {
        initiatedBy: { username: 'kubernanny' },
        info: [{ name: 'Reason', value: 'Sync from the Kubernanny app' }],
        sync: {
          syncStrategy: { hook: {} },
          ...(prune ? { prune: true } : {}),
          ...(syncOptions.length > 0 ? { syncOptions } : {}),
        },
      },
    });
    return chosen
      ? t('action.done.syncWith', { app: action.app, options: describeOptions(chosen) })
      : t('action.done.sync', { app: action.app });
  }

  /** A new Job from a CronJob's template (`kubectl create job --from=cronjob/…`), or a copy of a failed stand-alone Job. */
  private async rerunJob(action: Extract<IssueAction, { type: 'job-rerun' }>): Promise<Text> {
    const base = `/apis/batch/v1/namespaces/${enc(action.namespace)}`;
    interface Meta {
      name?: string;
      uid?: string;
      labels?: Record<string, string>;
      annotations?: Record<string, string>;
      ownerReferences?: unknown[];
    }
    if (action.from === 'CronJob') {
      const cron = await this.kube.get<{
        metadata: Meta;
        spec?: { jobTemplate?: { metadata?: Meta; spec?: Record<string, unknown> } };
      }>(`${base}/cronjobs/${enc(action.name)}`);
      const template = cron.spec?.jobTemplate;
      this.refuseRisky(action.name, (template?.spec as { template?: PodTemplateRisk } | undefined)?.template);
      await this.kube.create(`${base}/jobs`, {
        apiVersion: 'batch/v1',
        kind: 'Job',
        metadata: {
          generateName: `${action.name.slice(0, 44)}-manual-`,
          labels: { ...(template?.metadata?.labels ?? {}), ...CREATED_BY },
          annotations: { ...(template?.metadata?.annotations ?? {}), 'cronjob.kubernetes.io/instantiate': 'manual' },
          // Owned by the CronJob, like kubectl's: its history limit cleans it up and the check reads it as the CronJob's newest run.
          ownerReferences: [
            { apiVersion: 'batch/v1', kind: 'CronJob', name: action.name, uid: cron.metadata.uid, controller: true },
          ],
        },
        spec: template?.spec ?? {},
      });
      return t('action.done.jobRerunCron', { cron: action.name });
    }
    const job = await this.kube.get<{
      metadata: Meta;
      spec?: Record<string, unknown> & { template?: { metadata?: Meta } };
      status?: { conditions?: Condition[] };
    }>(`${base}/jobs/${enc(action.name)}`);
    if (
      (job.metadata.ownerReferences ?? []).length > 0 ||
      !job.status?.conditions?.some((c) => c.type === 'Failed' && c.status === 'True')
    ) {
      throw new ConflictError({ code: 'TARGET_CHANGED', message: t('error.targetChanged') });
    }
    const without = (labels: Record<string, string> | undefined) =>
      Object.fromEntries(Object.entries(labels ?? {}).filter(([k]) => !JOB_CONTROLLER_LABELS.includes(k)));
    const { selector: _selector, manualSelector: _manual, template, ...spec } = job.spec ?? {};
    this.refuseRisky(action.name, template as PodTemplateRisk | undefined);
    await this.kube.create(`${base}/jobs`, {
      apiVersion: 'batch/v1',
      kind: 'Job',
      metadata: {
        generateName: `${action.name.slice(0, 44)}-rerun-`,
        labels: { ...without(job.metadata.labels), ...CREATED_BY, [RERUN_LABEL]: action.name },
      },
      spec: {
        ...spec,
        template: { ...template, metadata: { ...template?.metadata, labels: without(template?.metadata?.labels) } },
      },
    });
    return t('action.done.jobRerun', { job: action.name });
  }

  private refuseRisky(name: string, template: PodTemplateRisk | undefined): void {
    const risky = riskyPodTemplate(template);
    if (risky) {
      throw new ConflictError({
        code: 'JOB_PRIVILEGED',
        message: t('error.jobPrivileged', { job: name, what: risky }),
      });
    }
  }

  private async reconcile(action: Extract<IssueAction, { type: 'reconcile-now' }>): Promise<Text> {
    if (action.kind === 'Certificate') {
      // `cmctl renew`: the Issuing condition set to True with reason ManuallyTriggered, on the status subresource.
      const path = `/apis/cert-manager.io/v1/namespaces/${enc(action.namespace)}/certificates/${enc(action.name)}`;
      const cert = await this.kube.get<{
        metadata: { resourceVersion?: string; generation?: number };
        status?: { conditions?: (Condition & { observedGeneration?: number })[] };
      }>(path);
      const issuing = {
        type: 'Issuing',
        status: 'True',
        reason: 'ManuallyTriggered',
        message: 'Certificate re-issuance manually triggered',
        lastTransitionTime: new Date().toISOString(),
        observedGeneration: cert.metadata.generation,
      };
      const conditions = [...(cert.status?.conditions ?? []).filter((c) => c.type !== 'Issuing'), issuing];
      // resourceVersion: a merge patch replaces the whole list, so it must not overwrite a change made in between.
      await this.kube.mergePatch(`${path}/status`, {
        metadata: { resourceVersion: cert.metadata.resourceVersion },
        status: { conditions },
      });
      return t('action.done.renew', { name: action.name });
    }
    const target = RECONCILE[action.kind];
    await this.kube.mergePatch(target.path.replace('{ns}', enc(action.namespace)).replace('{name}', enc(action.name)), {
      metadata: { annotations: { [target.annotation]: target.value() } },
    });
    return t('action.done.reconcile', { kind: action.kind, name: action.name });
  }

  async logs(
    issueId: string,
    index = 0,
    who?: Principal,
  ): Promise<{ pod: string; container?: string; previous: boolean; text: string }> {
    const action = this.find(issueId, 'logs', index);
    if (action.type !== 'logs') {
      throw new NotFoundError();
    }
    this.logger.log(
      `logs of ${action.namespace}/${action.pod} read by "${who?.name ?? 'unknown'}" (${who?.id ?? '-'})`,
    );
    const params = new URLSearchParams({ tailLines: '300', timestamps: 'true', limitBytes: String(LOG_LIMIT_BYTES) });
    if (action.container) {
      params.set('container', action.container);
    }
    if (action.previous) {
      params.set('previous', 'true');
    }
    const text = await this.kube.text(
      `/api/v1/namespaces/${enc(action.namespace)}/pods/${enc(action.pod)}/log?${params}`,
      2 * LOG_LIMIT_BYTES,
    );
    return { pod: action.pod, container: action.container, previous: action.previous ?? false, text };
  }
}
