import type { ImageRef } from '../modules/image-updates/image-ref';
import type { TagSource } from '../modules/image-updates/registry-client';
import type { DemoScenario } from './demo-cluster';

/**
 * Tag lists as a registry would answer them, so the demo and the tests never
 * call one. Only the broken cluster has something newer to offer (Traefik a
 * patch and a minor, CloudNativePG a minor); the others run the newest
 * releases these lists know, so their demo stays without a hint.
 */
const TAGS: Record<string, string[]> = {
  'docker.io/rancher/mirrored-library-traefik': ['2.11.24', '3.3.5', '3.3.6', '3.3.7', '3.4.4', '3.5.3', 'v3.5.3'],
  'ghcr.io/cloudnative-pg/cloudnative-pg': ['1.25.3', '1.26.0', '1.26.1', '1.26.2', '1.27.1', '1.28.3', '1.28.3-ubi9'],
};

export class DemoRegistry implements TagSource {
  constructor(private readonly scenario: DemoScenario) {}

  async tags(ref: ImageRef): Promise<string[]> {
    const listed = this.scenario === 'broken' ? TAGS[`${ref.registry.name}/${ref.repository}`] : undefined;
    return listed ?? [ref.tag];
  }
}
