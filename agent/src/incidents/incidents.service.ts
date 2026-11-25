import { DemoKubeClient } from '../demo/demo-cluster';
import { demoIncidents } from '../demo/demo-incidents';
import { KubeClient } from '../kube/kube-client';
import { EpisodeLog, Episode } from '../notify/digest';
import type { IssueView } from '../status/status.service';
import { IncidentsView, buildIncidents } from '../views/incidents';

/**
 * Owns the episode log: the run loop records every run into it, the
 * notifier's weekly report and `GET /incidents` read it. In memory, like the
 * rest of the agent's state: after a restart the history starts again, and
 * `coveredSince` says from when.
 */
export class IncidentsService {
  private readonly log: EpisodeLog;

  constructor(kube?: KubeClient) {
    const now = Date.now();
    // The demo pretends to have watched for a week, so the app has a timeline to show.
    this.log = kube instanceof DemoKubeClient ? new EpisodeLog(now, demoIncidents(now, kube.scenario)) : new EpisodeLog(now);
  }

  get since(): number {
    return this.log.since;
  }

  record(issues: IssueView[], now: number): void {
    this.log.record(issues, now);
  }

  lastWeek(now: number): Episode[] {
    return this.log.lastWeek(now);
  }

  view(days: number, now: number): IncidentsView {
    return buildIncidents(this.log.lastWeek(now), this.log.since, now, days);
  }
}
