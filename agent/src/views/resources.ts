/** Requests and limits of pods as their specs declare them, for nodes, workloads and the overview. */
import { cpuMilli, FullPod, parseQuantity } from '../inventory/inventory';

export interface Resources {
  cpuRequestMilli: number;
  /** Sum of the limits that are set; containers without one add nothing. */
  cpuLimitMilli: number;
  memRequest: number;
  memLimit: number;
  /** Containers without a CPU or memory limit. */
  cpuUnlimited: number;
  memUnlimited: number;
}

export const NO_RESOURCES: Resources = {
  cpuRequestMilli: 0,
  cpuLimitMilli: 0,
  memRequest: 0,
  memLimit: 0,
  cpuUnlimited: 0,
  memUnlimited: 0,
};

/** A pod that holds resources on its node: scheduled and not finished. */
export function holdsResources(pod: FullPod): boolean {
  return Boolean(pod.spec?.nodeName) && pod.status?.phase !== 'Succeeded' && pod.status?.phase !== 'Failed';
}

/** The app containers' requests and limits (init containers run before and release theirs). */
export function podResources(pod: FullPod): Resources {
  const r = { ...NO_RESOURCES };
  for (const c of pod.spec?.containers ?? []) {
    r.cpuRequestMilli += cpuMilli(c.resources?.requests?.cpu);
    r.memRequest += parseQuantity(c.resources?.requests?.memory);
    if (c.resources?.limits?.cpu) {
      r.cpuLimitMilli += cpuMilli(c.resources.limits.cpu);
    } else {
      r.cpuUnlimited++;
    }
    if (c.resources?.limits?.memory) {
      r.memLimit += parseQuantity(c.resources.limits.memory);
    } else {
      r.memUnlimited++;
    }
  }
  return r;
}

export function addResources(a: Resources, b: Resources): Resources {
  return {
    cpuRequestMilli: a.cpuRequestMilli + b.cpuRequestMilli,
    cpuLimitMilli: a.cpuLimitMilli + b.cpuLimitMilli,
    memRequest: a.memRequest + b.memRequest,
    memLimit: a.memLimit + b.memLimit,
    cpuUnlimited: a.cpuUnlimited + b.cpuUnlimited,
    memUnlimited: a.memUnlimited + b.memUnlimited,
  };
}
