import { Issue } from '../../checks/types';
import { t } from '../../i18n/text';

/** One API the cluster was asked for since the API server started, which a later Kubernetes removes. */
export interface DeprecatedApi {
  group: string;
  version: string;
  resource: string;
  /** "1.36" */
  removedRelease: string;
}

/**
 * The API server's own count of requests to deprecated APIs (a gauge, 1 per
 * API asked for since its start), as Prometheus scrapes it from every
 * kube-prometheus-stack. It does not say who asked; the audit log does.
 */
export const DEPRECATED_APIS_QUERY =
  'max by (group, version, resource, removed_release) (apiserver_requested_deprecated_apis)';

/** Prometheus samples to APIs; anything without a readable removal release is dropped. */
export function deprecatedApisFrom(samples: { metric: Record<string, string> }[]): DeprecatedApi[] {
  return samples
    .map((s) => ({
      group: s.metric['group'] ?? '',
      version: s.metric['version'] ?? '',
      resource: s.metric['resource'] ?? '',
      removedRelease: s.metric['removed_release'] ?? '',
    }))
    .filter((a) => /^1\.\d+$/.test(a.removedRelease) && a.version !== '' && a.resource !== '');
}

const minorOf = (release: string) => Number(release.split('.')[1]);
const shown = (a: DeprecatedApi) => `${a.group ? `${a.group}/` : ''}${a.version} ${a.resource}`;

/** The APIs a release after the running one removes. Releases already behind it cannot be asked for any more. */
export function pendingRemovals(apis: DeprecatedApi[], minor: string | null): DeprecatedApi[] {
  return minor === null ? [] : apis.filter((a) => minorOf(a.removedRelease) > minorOf(minor));
}

/**
 * One issue per Kubernetes release that removes APIs still in use: a warning
 * for the next minor (the upgrade would break whatever still asks for them),
 * a hint for later ones.
 */
export function evaluateDeprecatedApis(apis: DeprecatedApi[], minor: string | null): Issue[] {
  const current = minor === null ? 0 : minorOf(minor);
  const byRelease = new Map<string, DeprecatedApi[]>();
  for (const api of pendingRemovals(apis, minor)) {
    byRelease.set(api.removedRelease, [...(byRelease.get(api.removedRelease) ?? []), api]);
  }
  return [...byRelease.entries()]
    .sort(([a], [b]) => minorOf(a) - minorOf(b))
    .map(([release, list]) => {
      const names = [...new Set(list.map(shown))].sort();
      return {
        id: `kubernetes-support/deprecated-apis/${release}`,
        check: 'kubernetes-support',
        severity: minorOf(release) === current + 1 ? 'warning' : 'info',
        title: t('kubernetesSupport.deprecated.title', { n: names.length, release }),
        cause: t('kubernetesSupport.deprecated.cause', {
          apis: names.slice(0, 6).join(', ') + (names.length > 6 ? ', …' : ''),
          release,
        }),
        actions: [],
      };
    });
}
