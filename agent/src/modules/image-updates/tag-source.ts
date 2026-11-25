import { DemoKubeClient } from '../../demo/demo-cluster';
import { DemoRegistry } from '../../demo/demo-registry';
import { KubeClient } from '../../kube/kube-client';
import { RegistryClient, TagSource } from './registry-client';

/** The demo cluster gets canned tag lists, so neither the demo nor the tests ever call a registry. */
export function tagSourceFor(kube: KubeClient): TagSource {
  return kube instanceof DemoKubeClient ? new DemoRegistry(kube.scenario) : new RegistryClient();
}
