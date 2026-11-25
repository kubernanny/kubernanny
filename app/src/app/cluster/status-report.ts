import { Light } from '../core/agent.model';
import { dateTime } from '../core/format';
import { TranslationKey } from '../i18n/dictionary';
import { Translator } from '../i18n/translator';
import { ClusterView, IssueCard } from './cluster-view';

const LIGHT: Record<Light, TranslationKey> = { green: 'report.green', yellow: 'report.yellow', red: 'report.red', unknown: 'report.unknown' };
const SEVERITY: Record<IssueCard['issue']['severity'], TranslationKey> = { critical: 'report.critical', warning: 'report.warning', info: 'report.info' };

export interface ReportInput {
  /** The name this device gave the cluster. */
  name: string;
  view: ClusterView;
  /** When the agent last checked, ISO; null before the first answer. */
  checkedAt: string | null;
  agentVersion: string | null;
  /** Set while the agent does not answer: the report then says it shows the last known state. */
  error: string | null;
}

function issueLines(cards: IssueCard[], tr: Translator, withUntil = false): string[] {
  return cards.flatMap((c) => [
    `- [${tr.t(SEVERITY[c.issue.severity])}] ${c.issue.title}`,
    ...(c.issue.cause ? [`  ${c.issue.cause}`] : []),
    `  ${[c.area, withUntil && c.silencedText ? c.silencedText : c.sinceText].join(', ')}`,
  ]);
}

/**
 * The cluster's state as plain text, for a forum post or a chat: what the
 * person sees, in the UI language. Only what is on screen anyway; no issue
 * ids, addresses or keys, so it can be pasted publicly.
 */
export function statusReport({ name, view, checkedAt, agentVersion, error }: ReportInput, tr: Translator): string {
  const light = tr.t(LIGHT[view.stale ? 'unknown' : view.light]);
  const lines = [
    tr.t('report.heading', { cluster: name }),
    tr.t('report.state', { headline: view.headline, light }),
    ...(view.subline ? [view.subline] : []),
    ...(checkedAt ? [tr.t('report.asOf', { time: dateTime(checkedAt, tr.lang) })] : []),
    ...(agentVersion ? [tr.t('report.agent', { version: agentVersion })] : []),
    ...(error ? [tr.t('report.stale', { error })] : []),
    '',
  ];
  if (view.issues.length) {
    lines.push(tr.t('report.issues', { count: view.issues.length }), ...issueLines(view.issues, tr), '');
  } else {
    lines.push(tr.t('report.none'), '');
  }
  if (view.hints.length) {
    lines.push(tr.t('report.hints', { count: view.hints.length }), ...issueLines(view.hints, tr), '');
  }
  if (view.silenced.length) {
    lines.push(tr.t('report.silenced', { count: view.silenced.length }), ...issueLines(view.silenced, tr, true), '');
  }
  return lines.join('\n').trimEnd() + '\n';
}
