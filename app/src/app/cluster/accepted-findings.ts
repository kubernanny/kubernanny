import { ModuleView } from '../core/agent.model';
import { Translator } from '../i18n/translator';

export interface AcceptedFindingRow {
  key: string;
  /** "discourse". */
  name: string;
  /** "Deployment, discourse". */
  where: string;
  /** The annotation key, as written in Git. */
  findingKey: string;
  /** "may run as root". */
  finding: string;
  reason: string;
  /** "From the annotation kubernanny.io/accept on the workload". */
  source: string;
}

/** The security sheet's folded list of hints accepted in Git, every value worked out once. */
export function acceptedFindingRows(m: ModuleView, tr: Translator): AcceptedFindingRow[] {
  return (m.acceptedFindings ?? []).map((a) => ({
    key: `${a.namespace}/${a.kind}/${a.name}/${a.key}`,
    name: a.name,
    where: `${a.kind}, ${a.namespace}`,
    findingKey: a.key,
    finding: a.finding,
    reason: a.reason,
    source: tr.t(
      a.source === 'pod-template' ? 'module.acceptedFromTemplate' : 'module.acceptedFromWorkload',
    ),
  }));
}
