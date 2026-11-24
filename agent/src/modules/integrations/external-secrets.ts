import { ReadyConditionIntegration } from './ready-condition';

export class ExternalSecretsIntegration extends ReadyConditionIntegration {
  readonly id = 'external-secrets';

  constructor() {
    super('External Secrets', [
      { path: '/apis/external-secrets.io/v1/externalsecrets', kind: 'ExternalSecret' },
      { path: '/apis/external-secrets.io/v1/clustersecretstores', kind: 'ClusterSecretStore' },
    ]);
  }
}
