import { Lang, Text, render, t } from '../i18n/text';
import type { IssueView } from '../status/snapshot';

export interface NotifyPlan {
  opened: IssueView[];
  /** Issues pushed earlier that are gone now, with the title they had. */
  resolved: { id: string; title: Text }[];
  /** A pushed warning that turned critical. */
  escalated: IssueView[];
}

export interface Pushed {
  title: Text;
  severity: 'warning' | 'critical';
}

/**
 * What to push this run. An issue is pushed once it has lasted `afterMs`
 * (rollouts and kured reboots heal before that), again only if it turns
 * critical, and its end is pushed only if its start was.
 */
export function planNotifications(
  pushed: Map<string, Pushed>,
  issues: IssueView[],
  now: Date,
  afterMs: number,
): NotifyPlan {
  const plan: NotifyPlan = { opened: [], resolved: [], escalated: [] };
  // Hints are shown in the app, never pushed. A silenced issue sends nothing
  // new, but still counts as present: silencing is no reason to say "resolved".
  const pushable = issues.filter((i) => i.severity !== 'info');
  const current = new Set(pushable.map((i) => i.id));
  const relevant = pushable.filter((i) => !i.silencedUntil);
  for (const issue of relevant) {
    const before = pushed.get(issue.id);
    if (!before) {
      if (now.getTime() - Date.parse(issue.since) >= afterMs) {
        plan.opened.push(issue);
      }
    } else if (before.severity === 'warning' && issue.severity === 'critical') {
      plan.escalated.push(issue);
    }
  }
  for (const [id, p] of pushed) {
    if (!current.has(id)) {
      plan.resolved.push({ id, title: p.title });
    }
  }
  return plan;
}

export function formatPush(
  cluster: string,
  plan: NotifyPlan,
  detail: 'full' | 'minimal',
  lang: Lang,
): { title: string; body: string; priority: number; tags: string } | null {
  const bad = [...plan.escalated, ...plan.opened];
  if (bad.length === 0 && plan.resolved.length === 0) {
    return null;
  }
  const s = (text: Text) => render(text, lang);
  const critical = bad.some((i) => i.severity === 'critical');
  if (detail === 'minimal') {
    // Nothing about the cluster's contents: no namespaces, names, hosts or messages.
    const crit = bad.filter((i) => i.severity === 'critical').length;
    const parts = [
      crit ? t('push.minimal.critical', { n: crit }) : null,
      bad.length - crit ? t('push.minimal.warnings', { n: bad.length - crit }) : null,
      plan.resolved.length ? t('push.minimal.resolved', { n: plan.resolved.length }) : null,
    ].filter((p) => p !== null);
    return {
      title: s(bad.length === 0 ? t('push.minimal.titleResolved', { cluster }) : t('push.minimal.titleNew', { cluster })),
      body: s(t('push.minimal.body', { parts })),
      priority: critical ? 5 : bad.length > 0 ? 3 : 2,
      tags: critical ? 'rotating_light' : bad.length > 0 ? 'warning' : 'white_check_mark',
    };
  }
  const lines = [
    ...bad.map((i) => `${i.severity === 'critical' ? '🔴' : '🟡'} ${s(i.title)}: ${s(i.cause)}`),
    ...plan.resolved.map((r) => s(t('push.resolvedLine', { title: r.title }))),
  ];
  const title =
    bad.length === 0
      ? s(t('push.title.resolved', { cluster, n: plan.resolved.length }))
      : bad.length === 1
        ? `${cluster}: ${s(bad[0].title)}`
        : s(t('push.title.many', { cluster, n: bad.length }));
  return {
    title,
    body: lines.join('\n'),
    priority: critical ? 5 : bad.length > 0 ? 3 : 2,
    tags: critical ? 'rotating_light' : bad.length > 0 ? 'warning' : 'white_check_mark',
  };
}

/**
 * A change that could blind or lock out the owner if a stolen device made it
 * (docs/SECURITY.md, "A stolen device key"). Each one is announced through
 * every channel, even with notifications switched off in the app or during a
 * maintenance window; only `checks.disabled: [notifications]` in Helm silences them.
 */
export type SecurityEvent =
  | { kind: 'notificationsOff' }
  | { kind: 'moduleOff'; id: string }
  /** A default-off module (one that sends data out of the cluster) switched on. */
  | { kind: 'moduleOn'; id: string }
  | { kind: 'actionOff'; id: string }
  | { kind: 'maintenance'; hours: number }
  | { kind: 'deviceRevoked'; device: string }
  | { kind: 'devicePaired' }
  | { kind: 'advisoryAccepted'; component: string; advisory: string; days: number }
  | { kind: 'silenced'; issue: string; hours: number }
  | { kind: 'rolledBack'; app: string; from: string; to: string };

const SECURITY_LINE: { [K in SecurityEvent['kind']]: (by: string, e: Extract<SecurityEvent, { kind: K }>) => Text } = {
  notificationsOff: (by) => t('push.security.notificationsOff', { by }),
  moduleOff: (by, e) => t('push.security.moduleOff', { by, id: e.id }),
  moduleOn: (by, e) => t('push.security.moduleOn', { by, id: e.id }),
  actionOff: (by, e) => t('push.security.actionOff', { by, id: e.id }),
  maintenance: (by, e) => t('push.security.maintenance', { by, hours: e.hours }),
  deviceRevoked: (by, e) => t('push.security.deviceRevoked', { by, device: e.device }),
  devicePaired: (by) => t('push.security.devicePaired', { by }),
  advisoryAccepted: (by, e) => t('push.security.advisoryAccepted', { by, advisory: e.advisory, component: e.component, days: e.days }),
  silenced: (by, e) => t('push.security.silenced', { by, issue: e.issue, hours: e.hours }),
  rolledBack: (by, e) => t('push.security.rolledBack', { by, app: e.app, from: e.from, to: e.to }),
};

/** One short message naming the device (`by`) and what it changed; `minimal` names neither. */
export function formatSecurityAlert(cluster: string, by: string, events: SecurityEvent[], detail: 'full' | 'minimal', lang: Lang): Push {
  const s = (text: Text) => render(text, lang);
  const lines =
    detail === 'minimal'
      ? [s(t('push.security.minimal'))]
      : events.map((e) => s((SECURITY_LINE[e.kind] as (by: string, e: SecurityEvent) => Text)(by, e)));
  return { title: s(t('push.security.title', { cluster })), body: [...lines, s(t('push.security.advice'))].join('\n'), priority: 4, tags: 'lock' };
}

/** One message as every channel sends it. */
export type Push = NonNullable<ReturnType<typeof formatPush>>;
