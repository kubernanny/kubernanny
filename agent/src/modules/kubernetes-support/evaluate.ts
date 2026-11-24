import { Issue, IssueSeverity, ageText } from '../../checks/types';
import { Text, t } from '../../i18n/text';
import { KUBERNETES_EOL } from './releases';

const DAY = 86_400_000;
/** Warning this close to the end of life, a hint from HINT_DAYS on. */
export const WARN_DAYS = 60;
export const HINT_DAYS = 120;

export interface SupportState {
  /** "1.33", or null when the version could not be read. */
  minor: string | null;
  /** End of life (YYYY-MM-DD); null for a minor the table does not know (newer than it) or no version. */
  eol: string | null;
  /** Past its end of life. */
  ended: boolean;
  /** The oldest minor still maintained that is newer than the running one, e.g. "1.35". */
  next: string | null;
  issues: Issue[];
}

/** Where each distribution explains its upgrade, written out (issues carry no links). */
export function upgradeGuide(distribution: string): string {
  switch (distribution) {
    case 'RKE2':
      return 'https://docs.rke2.io/upgrades/manual_upgrade';
    case 'k3s':
      return 'https://docs.k3s.io/upgrades';
    case 'EKS':
    case 'GKE':
    case 'AKS':
      // Managed clusters are upgraded through the provider; its console names the versions it offers.
      return 'https://kubernetes.io/releases/';
    default:
      return 'https://kubernetes.io/docs/tasks/administer-cluster/kubeadm/kubeadm-upgrade/';
  }
}

/**
 * Compares the API server's minor version with the end-of-life table: a hint
 * from 120 days before the end, a warning from 60 days before and after it.
 * A minor newer than the table is unknown, not a problem; one older than the
 * table ended long ago.
 */
export function evaluateKubernetesSupport(
  gitVersion: string | undefined,
  now: Date,
  distribution: string,
  table: Readonly<Record<number, string>> = KUBERNETES_EOL,
): SupportState {
  const match = /^v?1\.(\d+)/.exec(gitVersion ?? '');
  if (!match) {
    return { minor: null, eol: null, ended: false, next: null, issues: [] };
  }
  const minor = Number(match[1]);
  const known = Object.keys(table).map(Number).sort((a, b) => a - b);
  const version = `1.${minor}`;
  if (known.length === 0 || minor > known[known.length - 1]!) {
    return { minor: version, eol: null, ended: false, next: null, issues: [] };
  }
  const eol = table[minor] ?? null;
  const end = eol ? Date.parse(`${eol}T23:59:59Z`) : -Infinity;
  const left = end - now.getTime();
  const nextMinor = known.find((m) => m > minor && Date.parse(`${table[m]}T23:59:59Z`) > now.getTime());
  const next = nextMinor === undefined ? null : `1.${nextMinor}`;
  const ended = left < 0;

  let severity: IssueSeverity | null = null;
  if (ended) {
    // Past the end with nothing newer in the table means the table is older than the cluster's world; only a hint then.
    severity = next ? 'warning' : 'info';
  } else if (left <= WARN_DAYS * DAY) {
    severity = 'warning';
  } else if (left <= HINT_DAYS * DAY) {
    severity = 'info';
  }
  if (severity === null) {
    return { minor: version, eol, ended, next, issues: [] };
  }
  const parts: Text[] = [
    ended
      ? eol
        ? t('kubernetesSupport.cause.ended', { version, date: eol })
        : t('kubernetesSupport.cause.endedLongAgo', { version })
      : t('kubernetesSupport.cause.ending', { version, date: eol ?? '' }),
    next ? t('kubernetesSupport.cause.next', { next }) : t('kubernetesSupport.cause.newer'),
    t('kubernetesSupport.cause.guide', { guide: upgradeGuide(distribution) }),
  ];
  return {
    minor: version,
    eol,
    ended,
    next,
    issues: [
      {
        id: `kubernetes-support/${version}`,
        check: 'kubernetes-support',
        severity,
        title: ended ? t('kubernetesSupport.ended.title', { version }) : t('kubernetesSupport.ending.title', { version, age: ageText(left) }),
        cause: t('common.sentences', { parts }),
        actions: [],
      },
    ],
  };
}
