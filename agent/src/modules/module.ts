import { ActionType, Issue, IssueActionType } from '../checks/types';
import type { Config } from '../config';
import type { Text } from '../i18n/text';
import { Detected } from '../discovery/discovery';
import { ServiceHttp } from './service-proxy';
import { boundDetails, boundStats, capIssues } from './untrusted';
import type { InventoryKind } from '../inventory/inventory';
import { ApiRead, ModuleContext, ModuleResult } from './types';

/**
 * What every module declares about itself. The agent, the Helm chart and the
 * tests read these declarations instead of trusting each module's code:
 *
 * - `reads`: every API resource the module lists or gets. The chart's RBAC is
 *   generated from it (`npm run rbac`), and a module switched off in the chart
 *   gets no permission at all.
 * - `actions`: the action types its issues may offer. Anything else is
 *   stripped, and switched-off action types are stripped too.
 */
export abstract class CheckModule {
  /** Stable id: catalog id for integrations, e.g. "argocd". Used in settings, Helm values and issue grouping. */
  abstract readonly id: string;
  abstract readonly reads: readonly ApiRead[];
  readonly actions: readonly ActionType[] = [];
  /**
   * The inventory lists its judgement rests on. When one of them could not be
   * read in a run (Inventory.stale) the module reports `error`: its issues
   * come from the last known objects, and the light must not turn green on
   * them. By default the lists most checks look at; events and routes only
   * feed the views and component links.
   */
  readonly uses: readonly InventoryKind[] = ['nodes', 'pods', 'deployments', 'statefulsets', 'daemonsets', 'jobs', 'cronjobs', 'services', 'pvcs'];

  /** Drops every action this module did not declare or that is switched off. */
  protected keepActions(issues: Issue[], allowed: (type: IssueActionType) => boolean): Issue[] {
    return issues.map((i) => ({ ...i, actions: i.actions.filter((a) => this.actions.includes(a.type) && allowed(a.type)) }));
  }
}

/** Always-on checks of Kubernetes itself (nodes, etcd, workloads, …). */
export abstract class CoreCheck extends CheckModule {
  abstract readonly name: Text;
  abstract readonly icon: string;
  abstract readonly description: Text;
  /**
   * Off until someone switches it on (Helm, env `ENABLED_MODULES` or the
   * app). For modules that send anything out of the cluster: nothing leaves
   * it unless configured.
   */
  readonly defaultOff: boolean = false;

  /** What the module sends out of the cluster, shown next to its switch. */
  privacy(_config: Config): Text | undefined {
    return undefined;
  }

  protected abstract check(ctx: ModuleContext): Promise<ModuleResult>;

  async run(ctx: ModuleContext, allowed: (type: IssueActionType) => boolean): Promise<ModuleResult> {
    const result = await this.check(ctx);
    return { ...result, issues: this.keepActions(result.issues, allowed) };
  }
}

/**
 * The deep check of one recognised component (Argo CD, Longhorn, …), one
 * subclass per file in `modules/integrations/`. To add one:
 *
 * ```ts
 * export class Harbor extends Integration {
 *   readonly id = 'harbor';                                   // catalog id
 *   readonly reads = [{ group: '<api group>', resource: '<plural>' }];
 *   protected async inspect(ctx: ModuleContext): Promise<ModuleResult> {
 *     const list = (await ctx.kube.list<…>(`/apis/<api group>/<version>/<plural>`)) ?? [];
 *     return { issues: …, stats: …, summary: … };
 *   }
 * }
 * ```
 *
 * then add it to `INTEGRATIONS` and run `npm run rbac`. Name, icon and
 * description come from the catalog entry with the same id.
 *
 * Trust: only an integration with `untrusted = true` may read plain HTTP
 * inside the cluster (`this.http()`, Prometheus). Anything that can run a pod
 * could answer in place of those services, so such an integration's issues
 * never carry actions, and the others do not even see the Prometheus client.
 */
export abstract class Integration extends CheckModule {
  readonly untrusted: boolean = false;

  protected abstract inspect(ctx: ModuleContext, det: Detected): Promise<ModuleResult>;

  async run(ctx: ModuleContext, det: Detected, allowed: (type: IssueActionType) => boolean): Promise<ModuleResult> {
    const scoped: ModuleContext = this.untrusted ? ctx : { ...ctx, prom: null };
    const result = await this.inspect(scoped, det);
    const issues = this.keepActions(result.issues, (t) => !this.untrusted && allowed(t));
    // An answer from an in-cluster service can be forged and as long as its sender likes.
    return this.untrusted ? { ...result, issues: capIssues(issues, this.id), stats: boundStats(result.stats), details: boundDetails(result.details) } : { ...result, issues };
  }

  /** The first service of the component with one of the ports, over cluster DNS. Untrusted integrations only. */
  protected http(ctx: ModuleContext, det: Detected, ports: (number | string)[]): ServiceHttp | null {
    if (!this.untrusted) {
      throw new Error(`${this.id}: reading in-cluster HTTP requires untrusted = true`);
    }
    const svc = det.services.find((s) => s.spec?.ports?.some((p) => ports.includes(p.port) || (p.name !== undefined && ports.includes(p.name))));
    return svc ? ServiceHttp.forService(ctx.kube, svc, ports) : null;
  }
}
