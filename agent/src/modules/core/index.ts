import { CoreCheck } from '../module';
import { KubernetesSupportCheck } from '../kubernetes-support/kubernetes-support.check';
import { SecurityCheck } from '../security/security.check';
import { VulnerabilitiesCheck } from '../vulnerabilities/vulnerabilities.check';
import { ImageUpdatesCheck } from '../image-updates/image-updates.check';
import { NodeClocksCheck } from './node-clocks';
import { ApiServerCheck } from './api-server';
import { HpaCheck } from './autoscalers';
import { PdbCheck } from './disruption-budgets';
import { EtcdCheck } from './etcd';
import { NodesCheck } from './nodes';
import { VolumesCheck } from './volumes';
import { WorkloadsCheck } from './workloads';

export { evaluateNodeUsage } from './nodes';
export { evaluateVolumes } from './volumes';
export { evaluateJobs, evaluateWorkloads } from './workloads';
export { bytes, pct } from '../format';

/**
 * The checks of Kubernetes itself, one file each; every one can be switched
 * off like an integration (checks.disabled, or in the app). Order is the
 * order of the app's "Kubernetes" group.
 */
export const CORE_CHECKS: readonly CoreCheck[] = [
  new NodesCheck(),
  new NodeClocksCheck(),
  new EtcdCheck(),
  new ApiServerCheck(),
  new KubernetesSupportCheck(),
  new WorkloadsCheck(),
  new PdbCheck(),
  new HpaCheck(),
  new VolumesCheck(),
  new SecurityCheck(),
  new VulnerabilitiesCheck(),
  new ImageUpdatesCheck(),
];
