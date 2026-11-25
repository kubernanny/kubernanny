import { Issue, condition } from '../../checks/types';
import { raw, rawOr, t } from '../../i18n/text';
import { Integration } from '../module';
import { ApiRead, ModuleContext, ModuleResult, Stat } from '../types';
import { Conditioned } from './util';

export interface ReadyKind {
  /** "/apis/<group>/<version>/<resource>" */
  path: string;
  kind: string;
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
      return { group: group!, resource: resource!, why: `the Ready condition of every ${k.kind}` };
    });
  }

  protected async inspect(ctx: ModuleContext): Promise<ModuleResult> {
    const lists = await Promise.all(this.kinds.map(async (k) => ({ ...k, items: (await ctx.kube.list<Conditioned>(k.path).catch(() => null)) ?? [] })));
    const issues: Issue[] = [];
    const stats: Stat[] = [];
    for (const { kind, items } of lists) {
      let ready = 0;
      for (const item of items) {
        const c = condition(item.status?.conditions, 'Ready');
        if (c?.status === 'True') {
          ready++;
        } else if (c?.status === 'False') {
          const ns = item.metadata.namespace ?? '';
          issues.push({
            id: `${this.id}/${kind}/${ns}/${item.metadata.name}`,
            check: 'argocd',
            severity: 'warning',
            title: t('ready.notReady.title', { kind, name: `${ns}/${item.metadata.name}` }),
            cause: rawOr(c.message ?? c.reason, t('ready.notReady.cause', { label: this.label })),
            actions: [],
          });
        }
      }
      if (items.length) {
        stats.push({ label: raw(kind), value: t('ready.stat.value', { ready, total: items.length }), tone: ready === items.length ? 'ok' : 'warning' });
      }
    }
    return { issues, stats, summary: issues.length === 0 ? t('ready.summary.ok') : t('ready.summary.problems', { n: issues.length }) };
  }
}
