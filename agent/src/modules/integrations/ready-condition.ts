import { condition, Issue, ReconcileKind } from '../../checks/types';
import { raw, rawOr, t } from '../../i18n/text';
import { readyDetails } from '../details';
import { Integration } from '../module';
import { ApiRead, ModuleContext, ModuleResult, Stat } from '../types';
import { Conditioned } from './util';

export interface ReadyKind {
  /** "/apis/<group>/<version>/<resource>" */
  path: string;
  kind: string;
  /** The condition that carries the verdict; default `Ready`. */
  conditionType?: string;
  /** True when the condition reports a failure with status True (Infisical's InfisicalPushSecret `Reconcile`). */
  failureWhenTrue?: boolean;
  /** Its controller reconciles at once on an annotation (`reconcile-now`); unset: no such offer. */
  reconcile?: ReconcileKind;
}

/**
 * For operators whose resources carry a Ready condition (Flux, External
 * Secrets, Infisical, …): every resource with Ready=False is a warning with
 * the controller's message. A subclass only names its kinds.
 */
export abstract class ReadyConditionIntegration extends Integration {
  readonly reads: readonly ApiRead[];

  protected constructor(
    /** Shown in the cause when the controller gives no message. */
    private readonly label: string,
    private readonly kinds: readonly ReadyKind[],
  ) {
    super();
    this.reads = kinds.map((k) => {
      const [, , group, , resource] = k.path.split('/');
      return {
        group: group!,
        resource: resource!,
        why: `the ${k.conditionType ?? 'Ready'} condition of every ${k.kind}`,
      };
    });
  }

  protected async inspect(ctx: ModuleContext): Promise<ModuleResult> {
    const lists = await Promise.all(
      this.kinds.map(async (k) => ({
        ...k,
        items: (await ctx.kube.list<Conditioned>(k.path).catch(() => null)) ?? [],
      })),
    );
    const issues: Issue[] = [];
    const stats: Stat[] = [];
    let total = 0;
    let readyTotal = 0;
    for (const { kind, items, conditionType = 'Ready', failureWhenTrue = false, reconcile } of lists) {
      let ready = 0;
      const shortType = conditionType.split('/').pop()!;
      for (const item of items) {
        const c = condition(item.status?.conditions, conditionType);
        // A resource without the condition yet (just created, controller not there) is neither ready nor failed.
        const decided = c?.status === 'True' || c?.status === 'False';
        const ok = decided && (c!.status === 'True') !== failureWhenTrue;
        if (ok) {
          ready++;
        } else if (decided) {
          const ns = item.metadata.namespace ?? '';
          issues.push({
            id: `${this.id}/${kind}/${ns}/${item.metadata.name}`,
            check: this.id,
            severity: 'warning',
            title: t('ready.notReady.title', { kind, name: `${ns}/${item.metadata.name}` }),
            cause: rawOr(
              c?.message ?? c?.reason,
              t('ready.notReady.cause', { label: this.label, condition: `${shortType}=${c?.status}` }),
            ),
            actions: reconcile
              ? [{ type: 'reconcile-now', kind: reconcile, namespace: ns, name: item.metadata.name }]
              : [],
          });
        }
      }
      total += items.length;
      readyTotal += ready;
      if (items.length) {
        stats.push({
          label: raw(kind),
          value: t('ready.stat.value', { ready, total: items.length }),
          tone: ready === items.length ? 'ok' : 'warning',
        });
      }
    }
    // The summary and the stats count the same thing: resources without a verdict yet are named, not called ready.
    const summary =
      issues.length > 0
        ? t('ready.summary.problems', { n: issues.length })
        : readyTotal === total
          ? t('ready.summary.ok')
          : t('ready.summary.pending', { n: total - readyTotal });
    return { issues, stats, details: readyDetails(lists, ctx.now), summary };
  }
}
