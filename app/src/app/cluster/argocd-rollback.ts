import { ModuleView } from '../core/agent.model';
import { LOCALE } from '../i18n/lang';
import { Translator } from '../i18n/translator';

/** One earlier deployment the person can pick, every text worked out. */
export interface RollbackChoice {
  id: number;
  short: string;
  /** "12 Nov 2026, 14:03, a71e0c9": the button in the sheet. */
  label: string;
  /** The confirmation's sentence: app, from and to, and that the cluster then differs from Git. */
  confirm: string;
}

/** One manual-sync Argo CD app on the sheet, with its "Roll back" button. */
export interface RollbackRow {
  key: string;
  namespace: string;
  app: string;
  /** "Deployed now: c4d5e6f", or empty when the agent reports no revision. */
  now: string;
  sheetTitle: string;
  confirmTitle: string;
  choices: RollbackChoice[];
}

/** What the agent sends is shown, never trusted: ids are whole numbers, revisions short and plain. */
const SHORT = /^[0-9A-Za-z.+_-]{1,64}$/;

/**
 * The Argo CD sheet's rollback rows (agent/src/checks/argocd-rollback.ts),
 * newest deployment first, without the one deployed now. Empty when the
 * agent sends none, which is the case unless the deployment opted in.
 */
export function rollbackRows(m: ModuleView, tr: Translator): RollbackRow[] {
  if (m.id !== 'argocd') {
    return [];
  }
  const date = (iso: string | undefined) => {
    const ms = iso ? Date.parse(iso) : NaN;
    return Number.isNaN(ms)
      ? '?'
      : new Date(ms).toLocaleString(LOCALE[tr.lang], {
          day: 'numeric',
          month: 'short',
          year: 'numeric',
          hour: '2-digit',
          minute: '2-digit',
        });
  };
  return (m.rollbacks ?? []).flatMap((a) => {
    const from = a.current && SHORT.test(a.current) ? a.current : '?';
    const choices = a.entries
      .filter((e) => !e.current && Number.isSafeInteger(e.id) && SHORT.test(e.short))
      .sort((x, y) => y.id - x.id)
      .map((e) => ({
        id: e.id,
        short: e.short,
        label: tr.t('module.rollbackChoice', { date: date(e.deployedAt), revision: e.short }),
        confirm: tr.t('module.rollbackConfirm', { app: a.app, from, to: e.short }),
      }));
    if (choices.length === 0) {
      return [];
    }
    return [
      {
        key: `${a.namespace}/${a.app}`,
        namespace: a.namespace,
        app: a.app,
        now:
          a.current && SHORT.test(a.current)
            ? tr.t('module.rollbackNow', { revision: a.current })
            : '',
        sheetTitle: tr.t('module.rollbackSheet', { app: a.app }),
        confirmTitle: tr.t('module.rollbackConfirmTitle', { app: a.app }),
        choices,
      },
    ];
  });
}

/** The module with `id` as the deployment of that app now, until the status reloads. */
export function markRolledBack(
  m: ModuleView,
  row: Pick<RollbackRow, 'namespace' | 'app'>,
  id: number,
): ModuleView {
  return {
    ...m,
    rollbacks: (m.rollbacks ?? []).map((a) => {
      const target =
        a.namespace === row.namespace && a.app === row.app
          ? a.entries.find((e) => e.id === id)
          : undefined;
      return target
        ? {
            ...a,
            current: target.short,
            entries: a.entries.map((e) => ({ ...e, current: e.id === id })),
          }
        : a;
    }),
  };
}
