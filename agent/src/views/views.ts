/** The detail views behind the app's tabs, one file each; computed from the last run, no extra API calls. */
export { buildEvents, EventView } from './events';
export { Health } from './health';
export { buildNetwork, IngressView, NetworkView } from './network';
export { buildNodes, NodeView } from './nodes';
export { buildStorage, StorageView, VolumeView } from './storage';
export { buildWorkloads, WorkloadView } from './workloads';
