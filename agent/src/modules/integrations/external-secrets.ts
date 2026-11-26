import { ReadyConditionIntegration } from './ready-condition';

export class ExternalSecretsIntegration extends ReadyConditionIntegration {
  readonly id = 'external-secrets';

  override readonly actions = ['reconcile-now'] as const;

  constructor() {
    super('External Secrets', [
      { path: '/apis/external-secrets.io/v1/externalsecrets', kind: 'ExternalSecret', reconcile: 'ExternalSecret' },
      { path: '/apis/external-secrets.io/v1/clustersecretstores', kind: 'ClusterSecretStore' },
    ]);
  }
}
