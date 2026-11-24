import type { Config } from '../../config';
import { DemoKubeClient } from '../../demo/demo-cluster';
import { DemoVulnDb } from '../../demo/demo-vulns';
import { KubeClient } from '../../kube/kube-client';
import { OsvClient, VulnDb } from './osv-client';

/** The demo cluster gets canned OSV answers, so neither the demo nor the tests ever call the internet. */
export function vulnDbFor(kube: KubeClient, config: Pick<Config, 'vulnDbUrl'>): VulnDb {
  return kube instanceof DemoKubeClient ? new DemoVulnDb() : new OsvClient(config.vulnDbUrl);
}
