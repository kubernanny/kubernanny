import { ReadyConditionIntegration } from './ready-condition';

/** Both CRDs of the Infisical operator: the dynamic and the static (InfisicalStaticSecret) variant. */
export class InfisicalIntegration extends ReadyConditionIntegration {
  readonly id = 'infisical';

  constructor() {
    super('Infisical', [
      { path: '/apis/secrets.infisical.com/v1beta1/infisicalsecrets', kind: 'InfisicalSecret' },
      { path: '/apis/secrets.infisical.com/v1beta1/infisicalstaticsecrets', kind: 'InfisicalStaticSecret' },
    ]);
  }
}
