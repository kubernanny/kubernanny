import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { IssueAction, IssueActionType, WorkloadKind } from '../checks/types';
import type { Principal } from '../auth/devices.service';
import { Text, t } from '../i18n/text';
import { KubeClient } from '../kube/kube-client';
import { SettingsService } from '../settings/settings.service';
import { StatusService } from '../status/status.service';

const WORKLOAD_PATH: Record<WorkloadKind, string> = {
  Deployment: 'deployments',
  StatefulSet: 'statefulsets',
  DaemonSet: 'daemonsets',
};

const enc = encodeURIComponent;

/**
 * Runs an action of an issue the agent currently sees. The request only names
 * the issue and the action type; namespace, name and kind come from the
 * agent's own check result, so a stolen token cannot restart arbitrary
 * workloads, only the ones that are broken right now.
 */
@Injectable()
export class ActionsService {
  private readonly logger = new Logger(ActionsService.name);

  constructor(
    @Inject(KubeClient) private readonly kube: KubeClient,
    @Inject(StatusService) private readonly status: StatusService,
    @Inject(SettingsService) private readonly settings: SettingsService,
  ) {}

  find(issueId: string, type: IssueActionType, index = 0): IssueAction {
    // The snapshot drops switched-off actions too; this covers the moment between a switch and the next run.
    if (!this.settings.actionOn(type)) {
      throw new ForbiddenException({ code: 'ACTION_DISABLED', message: t('error.actionDisabled') });
    }
    const issue = this.status.findIssue(issueId);
    if (!issue) {
      throw new ConflictException({ code: 'ISSUE_GONE', message: t('error.issueGone') });
    }
    const action = issue.actions.filter((a) => a.type === type)[index];
    if (!action) {
      throw new NotFoundException({ code: 'ACTION_NOT_OFFERED', message: t('error.actionNotOffered', { type }) });
    }
    return action;
  }

  async run(issueId: string, type: IssueActionType, index = 0, who?: Principal): Promise<{ done: Text }> {
    const action = this.find(issueId, type, index);
    // The audit trail: who ran what on which object.
    this.logger.log(`action ${type} by "${who?.name ?? 'unknown'}" (${who?.id ?? '-'}) on ${issueId}: ${JSON.stringify(action)}`);
    let done: Text;
    switch (action.type) {
      case 'argocd-sync':
        await this.kube.mergePatch(`/apis/argoproj.io/v1alpha1/namespaces/${enc(action.namespace)}/applications/${enc(action.app)}`, {
          operation: {
            initiatedBy: { username: 'kubernanny' },
            info: [{ name: 'Reason', value: 'Sync from the Kubernanny app' }],
            sync: { syncStrategy: { hook: {} } },
          },
        });
        done = t('action.done.sync', { app: action.app });
        break;
      case 'argocd-refresh':
        await this.kube.mergePatch(`/apis/argoproj.io/v1alpha1/namespaces/${enc(action.namespace)}/applications/${enc(action.app)}`, {
          metadata: { annotations: { 'argocd.argoproj.io/refresh': 'hard' } },
        });
        done = t('action.done.refresh', { app: action.app });
        break;
      case 'restart':
        await this.kube.mergePatch(
          `/apis/apps/v1/namespaces/${enc(action.namespace)}/${WORKLOAD_PATH[action.kind]}/${enc(action.name)}`,
          { spec: { template: { metadata: { annotations: { 'kubectl.kubernetes.io/restartedAt': new Date().toISOString() } } } } },
        );
        done = t('action.done.restart', { kind: action.kind, name: action.name });
        break;
      case 'cnpg-backup':
        await this.kube.create(`/apis/postgresql.cnpg.io/v1/namespaces/${enc(action.namespace)}/backups`, {
          apiVersion: 'postgresql.cnpg.io/v1',
          kind: 'Backup',
          metadata: { generateName: `${action.cluster}-kubernanny-`, labels: { 'app.kubernetes.io/created-by': 'kubernanny' } },
          spec: { cluster: { name: action.cluster } },
        });
        done = t('action.done.backup', { cluster: action.cluster });
        break;
      case 'logs':
        throw new BadRequestException({ code: 'USE_LOGS_ROUTE', message: t('error.useLogsRoute') });
    }
    void this.status.refresh();
    return { done };
  }

  async logs(issueId: string, index = 0, who?: Principal): Promise<{ pod: string; container?: string; previous: boolean; text: string }> {
    const action = this.find(issueId, 'logs', index);
    if (action.type !== 'logs') {
      throw new NotFoundException();
    }
    this.logger.log(`logs of ${action.namespace}/${action.pod} read by "${who?.name ?? 'unknown'}" (${who?.id ?? '-'})`);
    const params = new URLSearchParams({ tailLines: '300', timestamps: 'true' });
    if (action.container) {
      params.set('container', action.container);
    }
    if (action.previous) {
      params.set('previous', 'true');
    }
    const text = await this.kube.text(`/api/v1/namespaces/${enc(action.namespace)}/pods/${enc(action.pod)}/log?${params}`);
    return { pod: action.pod, container: action.container, previous: action.previous ?? false, text };
  }
}
