import { KubeClient, KubeError } from './kube-client';

/**
 * Writes keys of one ConfigMap in the agent's namespace, creating it when it
 * is missing. Several services keep their state as keys of the same
 * ConfigMap (switches, silences, acceptances, notified issues), so a create
 * can lose the race to another one (409): the patch then goes to the
 * ConfigMap that one created. Merge patch: only the given keys change.
 */
export async function upsertConfigMapData(
  kube: KubeClient,
  namespace: string,
  name: string,
  data: Record<string, string>,
): Promise<void> {
  const collection = `/api/v1/namespaces/${encodeURIComponent(namespace)}/configmaps`;
  const path = `${collection}/${encodeURIComponent(name)}`;
  try {
    await kube.mergePatch(path, { data });
    return;
  } catch (err) {
    if (!(err instanceof KubeError && err.status === 404)) {
      throw err;
    }
  }
  try {
    await kube.create(collection, {
      apiVersion: 'v1',
      kind: 'ConfigMap',
      metadata: { name, labels: { 'app.kubernetes.io/name': 'kubernanny' } },
      data,
    });
  } catch (err) {
    if (!(err instanceof KubeError && err.status === 409)) {
      throw err;
    }
    await kube.mergePatch(path, { data });
  }
}
