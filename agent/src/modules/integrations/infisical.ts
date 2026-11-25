import { ReadyConditionIntegration } from './ready-condition';

/**
 * The Infisical operator's secret kinds. None of them has a `Ready` condition;
 * each reports its last reconcile differently (operator v0.11, verified
 * against a live cluster and internal/services/<kind>/conditions.go):
 * - InfisicalSecret (v1alpha1): `secrets.infisical.com/ReadyToSyncSecrets`, False on error.
 * - InfisicalStaticSecret (v1beta1): `secrets.infisical.com/LastReconcileStatus`, False on error.
 * - InfisicalDynamicSecret (v1alpha1): `secrets.infisical.com/Reconcile`, False on error.
 * - InfisicalPushSecret (v1alpha1): `secrets.infisical.com/Reconcile` with the polarity
 *   inverted: True with reason Error when the push failed, False/OK on success.
 */
export class InfisicalIntegration extends ReadyConditionIntegration {
  readonly id = 'infisical';

  constructor() {
    super('Infisical', [
      { path: '/apis/secrets.infisical.com/v1alpha1/infisicalsecrets', kind: 'InfisicalSecret', conditionType: 'secrets.infisical.com/ReadyToSyncSecrets' },
      { path: '/apis/secrets.infisical.com/v1beta1/infisicalstaticsecrets', kind: 'InfisicalStaticSecret', conditionType: 'secrets.infisical.com/LastReconcileStatus' },
      { path: '/apis/secrets.infisical.com/v1alpha1/infisicaldynamicsecrets', kind: 'InfisicalDynamicSecret', conditionType: 'secrets.infisical.com/Reconcile' },
      { path: '/apis/secrets.infisical.com/v1alpha1/infisicalpushsecrets', kind: 'InfisicalPushSecret', conditionType: 'secrets.infisical.com/Reconcile', failureWhenTrue: true },
    ]);
  }
}
