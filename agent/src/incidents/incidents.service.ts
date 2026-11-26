import { DemoKubeClient } from '../demo/demo-cluster';
import { demoIncidents } from '../demo/demo-incidents';
import { KubeClient } from '../kube/kube-client';
import { Episode, EpisodeLog } from '../notify/digest';
import type { IssueView } from '../status/status.service';
import { buildIncidents, IncidentsView } from '../views/incidents';

/**
 * Owns the episode log: the run loop records every run into it, the
 * notifier's weekly report and `GET /incidents` read it. Kept in the
 * ConfigMap `kubernanny-history` by the history store (history/history-store.ts),
 * so a restart continues the week; `coveredSince` is the first start ever
 * (or this start, with `history.persist` off).
 */
export class IncidentsService {
  private readonly log: EpisodeLog;

  constructor(kube?: KubeClient) {
    const now = Date.now();
    // The demo pretends to have watched for a week, so the app has a timeline to show.
    this.log =
      kube instanceof DemoKubeClient ? new EpisodeLog(now, demoIncidents(now, kube.scenario)) : new EpisodeLog(now);
  }

  get since(): number {
    return this.log.since;
  }

  record(issues: IssueView[], now: number): void {
    this.log.record(issues, now);
  }

  /** Every episode kept, for the history store. */
  all(): Episode[] {
    return this.log.all();
  }

  /** What the history store read back joins the log. */
  merge(stored: { since: number; episodes: Episode[] }, now: number): void {
    this.log.merge(stored, now);
  }

  lastWeek(now: number): Episode[] {
    return this.log.lastWeek(now);
  }

  view(days: number, now: number): IncidentsView {
    return buildIncidents(this.log.lastWeek(now), this.log.since, now, days);
  }
}
