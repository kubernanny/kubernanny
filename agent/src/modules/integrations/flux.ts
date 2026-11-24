import { ReadyConditionIntegration } from './ready-condition';

export class FluxIntegration extends ReadyConditionIntegration {
  readonly id = 'flux';

  constructor() {
    super('Flux', [
      { path: '/apis/kustomize.toolkit.fluxcd.io/v1/kustomizations', kind: 'Kustomization' },
      { path: '/apis/helm.toolkit.fluxcd.io/v2/helmreleases', kind: 'HelmRelease' },
      { path: '/apis/source.toolkit.fluxcd.io/v1/gitrepositories', kind: 'GitRepository' },
    ]);
  }
}
