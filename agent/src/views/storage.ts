/** The Storage tab: StorageClasses and PVCs with capacity, use (Prometheus) and Longhorn state. */
import { Inventory, parseQuantity } from '../inventory/inventory';
import { RunData } from '../modules/types';

export interface VolumeView {
  namespace: string;
  name: string;
  phase?: string;
  storageClass?: string;
  capacity: number;
  accessModes: string[];
  used: number | null;
  usedBy: string[];
  longhorn?: { robustness?: string; state?: string; replicas?: number };
}

export interface StorageView {
  classes: {
    name: string;
    provisioner?: string;
    isDefault: boolean;
    reclaimPolicy?: string;
    expansion: boolean;
    volumes: number;
  }[];
  volumes: VolumeView[];
}

export function buildStorage(inv: Inventory, data: RunData): StorageView {
  const longhornByPv = new Map((data.longhornVolumes ?? []).map((v) => [v.metadata.name, v]));
  const usedBy = new Map<string, string[]>();
  for (const p of inv.pods) {
    for (const v of p.spec?.volumes ?? []) {
      if (v.persistentVolumeClaim) {
        const key = `${p.metadata.namespace}/${v.persistentVolumeClaim.claimName}`;
        usedBy.set(key, [...(usedBy.get(key) ?? []), p.metadata.name]);
      }
    }
  }
  const volumes = inv.pvcs
    .map((pvc) => {
      const ns = pvc.metadata.namespace ?? 'default';
      const key = `${ns}/${pvc.metadata.name}`;
      const lh = pvc.spec?.volumeName ? longhornByPv.get(pvc.spec.volumeName) : undefined;
      return {
        namespace: ns,
        name: pvc.metadata.name,
        phase: pvc.status?.phase,
        storageClass: pvc.spec?.storageClassName,
        capacity: parseQuantity(pvc.status?.capacity?.storage ?? pvc.spec?.resources?.requests?.storage),
        accessModes: pvc.spec?.accessModes ?? [],
        used: data.volumeUsage?.get(key)?.used ?? null,
        usedBy: usedBy.get(key) ?? [],
        longhorn: lh
          ? { robustness: lh.status?.robustness, state: lh.status?.state, replicas: lh.spec?.numberOfReplicas }
          : undefined,
      };
    })
    .sort((a, b) => a.namespace.localeCompare(b.namespace) || a.name.localeCompare(b.name));
  const classes = inv.storageClasses.map((sc) => ({
    name: sc.metadata.name,
    provisioner: sc.provisioner,
    isDefault: sc.metadata.annotations?.['storageclass.kubernetes.io/is-default-class'] === 'true',
    reclaimPolicy: sc.reclaimPolicy,
    expansion: sc.allowVolumeExpansion === true,
    volumes: volumes.filter((v) => v.storageClass === sc.metadata.name).length,
  }));
  return { classes, volumes };
}
