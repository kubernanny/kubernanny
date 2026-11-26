import { Inventory } from '../../inventory/inventory';
import { ACCEPT_ANNOTATION } from './accept-annotation';

/** "ns/job" -> its CronJob's name, so a CronJob's pods count as the CronJob. */
export function cronOfJobs(inv: Inventory): Map<string, string> {
  const cronOfJob = new Map<string, string>();
  for (const job of inv.jobs) {
    const cron = job.metadata.ownerReferences?.find((o) => o.kind === 'CronJob');
    if (cron) {
      cronOfJob.set(`${job.metadata.namespace}/${job.metadata.name}`, cron.name);
    }
  }
  return cronOfJob;
}

/** "ns/Kind/name" -> the workload's own `kubernanny.io/accept` annotation; its pod template's arrives on the pods. */
export function workloadAcceptAnnotations(inv: Inventory): Map<string, string> {
  const out = new Map<string, string>();
  for (const [kind, list] of [
    ['Deployment', inv.deployments],
    ['StatefulSet', inv.statefulsets],
    ['DaemonSet', inv.daemonsets],
    ['CronJob', inv.cronjobs],
  ] as const) {
    for (const w of list) {
      const value = w.metadata.annotations?.[ACCEPT_ANNOTATION];
      if (value) {
        out.set(`${w.metadata.namespace ?? 'default'}/${kind}/${w.metadata.name}`, value);
      }
    }
  }
  return out;
}
