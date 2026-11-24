import { BackupKind, BackupRow, BackupState, BackupTargetType, BackupsView, Tone } from '../core/agent.model';
import { relativeTime } from '../core/format';
import { TranslationKey } from '../i18n/dictionary';
import { Translator } from '../i18n/translator';

export interface BackupLine {
  id: string;
  name: string;
  namespace: string | null;
  tone: Tone;
  state: string;
  /** "zuletzt vor 9 h" / "noch nie gesichert" */
  last: string;
  /** Why the state is not ok, from the agent; null when it is. */
  note: string | null;
  /** "S3, s3://bucket/path" */
  target: string | null;
  /** "7 Backups vorhanden" */
  count: string | null;
}

export interface BackupGroup {
  kind: BackupKind;
  /** The tool, a product name in every language. */
  product: string;
  /** What it protects: "Datenbanken", "Volumes", … */
  what: string;
  lines: BackupLine[];
}

export interface BackupsVM {
  empty: boolean;
  /** "Alle 9 Backups sind aktuell." or "3 von 9 brauchen Aufmerksamkeit."; empty without rows. */
  summary: string;
  summaryTone: Tone;
  intro: string;
  groups: BackupGroup[];
  targets: { name: string; tone: Tone; text: string; availability: string }[];
  unprotected: { key: string; name: string; kind: string }[];
}

const ORDER: BackupKind[] = ['cnpg', 'longhorn', 'etcd', 'velero'];
const PRODUCT: Record<BackupKind, string> = { cnpg: 'CloudNativePG', longhorn: 'Longhorn', etcd: 'etcd', velero: 'Velero' };
const WHAT: Record<BackupKind, TranslationKey> = { cnpg: 'backups.cnpg', longhorn: 'backups.longhorn', etcd: 'backups.etcd', velero: 'backups.velero' };
const STATE: Record<BackupState, TranslationKey> = { ok: 'backups.ok', warning: 'backups.warning', critical: 'backups.critical' };
const RANK: Record<BackupState, number> = { critical: 0, warning: 1, ok: 2 };
/** Product and protocol names read the same in every language. */
const TYPE: Partial<Record<BackupTargetType, string>> = { s3: 'S3', azure: 'Azure Blob Storage', gcs: 'Google Cloud Storage', nfs: 'NFS', cifs: 'SMB' };

/** "S3, s3://bucket/path"; Velero names its storage location instead of a URL. */
export function targetText(target: { type: BackupTargetType; location?: string } | null, tr: Translator): string | null {
  if (!target) {
    return null;
  }
  const type = target.type === 'local' ? tr.t('backups.local') : TYPE[target.type];
  if (!type) {
    return target.location ? tr.t('backups.location', { location: target.location }) : tr.t('backups.targetUnknown');
  }
  return target.location ? `${type}, ${target.location}` : type;
}

function line(row: BackupRow, now: Date, tr: Translator): BackupLine {
  return {
    id: row.id,
    name: row.name,
    namespace: row.namespace ?? null,
    tone: row.state,
    state: tr.t(STATE[row.state]),
    // From the time, not ageMs: the answer may be minutes old, the page keeps counting.
    last: row.lastSuccess ? tr.t('backups.last', { when: relativeTime(row.lastSuccess, now, tr.lang) }) : tr.t('backups.never'),
    note: row.state !== 'ok' && row.note ? row.note : null,
    target: targetText(row.target, tr),
    count: row.count === null ? null : tr.n(row.kind === 'etcd' ? 'backups.snapshots' : 'backups.kept', row.count),
  };
}

/** The Backups tab: one group per tool, the worst first inside each; targets and what has no backup at all. */
export function backupsView(view: BackupsView | null, now: Date, tr: Translator): BackupsVM {
  const rows = view?.rows ?? [];
  const groups = ORDER.map((kind) => ({
    kind,
    product: PRODUCT[kind],
    what: tr.t(WHAT[kind]),
    lines: rows
      .filter((r) => r.kind === kind)
      .sort((a, b) => RANK[a.state] - RANK[b.state] || a.name.localeCompare(b.name))
      .map((r) => line(r, now, tr)),
  })).filter((g) => g.lines.length > 0);
  const bad = rows.filter((r) => r.state !== 'ok');
  const targets = (view?.targets ?? []).map((x) => ({
    name: x.name,
    tone: (x.available === false ? 'critical' : x.available ? 'ok' : 'muted') as Tone,
    text: targetText({ type: x.type, location: x.location }, tr) ?? x.location,
    availability: tr.t(x.available === false ? 'backups.unreachable' : x.available ? 'backups.reachable' : 'backups.unchecked'),
  }));
  const unprotected = (view?.unprotected ?? []).map((u) => ({
    key: `${u.kind}/${u.namespace ?? ''}/${u.name}`,
    name: u.namespace ? `${u.namespace}/${u.name}` : u.name,
    kind: tr.t(u.kind === 'cnpg' ? 'backups.database' : 'backups.volume'),
  }));
  return {
    empty: rows.length === 0 && targets.length === 0 && unprotected.length === 0,
    summary: !rows.length ? '' : bad.length ? tr.t('backups.needAttention', { bad: bad.length, count: rows.length }) : tr.n('backups.allGood', rows.length),
    summaryTone: bad.some((r) => r.state === 'critical') ? 'critical' : bad.length ? 'warning' : 'ok',
    intro: tr.t('backups.intro', { hours: view?.maxAgeHours ?? 26 }),
    groups,
    targets,
    unprotected,
  };
}
