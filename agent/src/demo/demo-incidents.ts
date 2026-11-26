import { ageText } from '../checks/types';
import { t } from '../i18n/text';
import type { Episode } from '../notify/digest';
import type { DemoScenario } from './demo-cluster';

const H = 3_600_000;
const D = 24 * H;
const M = 60_000;

/**
 * A believable last week for the demo cluster: resolved incidents only (what
 * is open now comes from the run itself), so the app's timeline has something
 * to show. The healthy cluster had a calm week, the broken one a rough one.
 */
export function demoIncidents(now: number, scenario: DemoScenario): { since: number; episodes: Episode[] } {
  const ended = (
    id: string,
    module: string,
    severity: Episode['severity'],
    title: Episode['title'],
    startAgo: number,
    lasted: number,
    silenced = false,
  ): Episode => ({
    id,
    title,
    severity,
    module,
    start: now - startAgo,
    end: now - startAgo + lasted,
    silenced,
  });
  const calm = [
    // kured rebooted a node at night; it came back before the notifier would have pushed.
    ended(
      'nodes/rke2-node-5/not-ready',
      'nodes',
      'critical',
      t('nodes.notReady.title', { node: 'rke2-node-5' }),
      2 * D + 3 * H,
      7 * M,
    ),
    ended(
      'certificates/default/shop-app-tls',
      'cert-manager',
      'warning',
      t('certificates.expiring.title', { host: 'shop.example', age: ageText(13 * D) }),
      6 * D + 5 * H,
      2 * H + 20 * M,
    ),
  ];
  const busy = [
    ended(
      'argocd/argocd/weblate-chart/operation',
      'argocd',
      'warning',
      t('argocd.syncFailed.title', { app: 'weblate-chart' }),
      1 * D + 4 * H,
      41 * M,
    ),
    ended(
      'cnpg/default/shop-api-pg/backup',
      'cnpg',
      'warning',
      t('cnpg.oldBackup.title', { cluster: 'default/shop-api-pg', age: ageText(27 * H) }),
      3 * D + 8 * H,
      6 * H + 10 * M,
    ),
  ];
  const rough = [
    ended(
      'pods/default/Deployment/shop-api-chart',
      'pods',
      'critical',
      t('pods.title', { workload: 'default/shop-api-chart', reason: 'CrashLoopBackOff', pods: 2 }),
      5 * D + 2 * H,
      23 * M,
    ),
    // Silenced while the replica rebuilt, then healed on its own.
    ended(
      'longhorn/pvc-weblate',
      'longhorn',
      'warning',
      t('longhorn.volume.title', { volume: 'pvc-weblate', robustness: 'degraded' }),
      4 * D + 1 * H,
      95 * M,
      true,
    ),
    ended(
      'nodes/rke2-node-4/memory',
      'nodes',
      'warning',
      t('nodes.memory.title', { node: 'rke2-node-4', pct: 92 }),
      2 * D + 11 * H,
      48 * M,
    ),
  ];
  const episodes =
    scenario === 'healthy' ? calm : scenario === 'warning' ? [...calm, ...busy] : [...calm, ...busy, ...rough];
  return { since: now - 7 * D, episodes };
}
