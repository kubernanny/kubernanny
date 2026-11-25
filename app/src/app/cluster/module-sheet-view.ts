import { DetailMeta, DetailRow, ModuleView, Stat, Tone } from '../core/agent.model';
import { Translator } from '../i18n/translator';

/** Healthy rows a list shows before "show all"; problems are always shown. */
export const HEALTHY_SHOWN = 5;

export interface SheetRow {
  key: string;
  name: string;
  sub?: string;
  value?: string;
  tone: Tone;
  /** A problem row: tinted, never folded away. */
  problem: boolean;
  meta: DetailMeta[];
  children: SheetRow[];
}

export interface SheetList {
  key: string;
  kind: 'list';
  title: string;
  rows: SheetRow[];
  /** Healthy rows behind "show all"; 0 when everything is shown. */
  folded: number;
  /** Rows the agent left out above its cap. */
  more: number;
  expandLabel: string;
  problems: number;
  count: string;
}

export interface SheetTable {
  key: string;
  kind: 'table';
  title: string;
  columns: string[];
  rows: { key: string; cells: string[]; tone: Tone }[];
  more: number;
  count: string;
}

export type SheetSection = SheetList | SheetTable;

export interface SheetView {
  /** Version and namespace, under the description. */
  meta: string;
  /** Two to four key figures, one row; `columns` sets the grid so it is never half empty. */
  figures: Stat[];
  columns: number;
  /** A label or value too long for a third of a phone's width. */
  longLabels: boolean;
  sections: SheetSection[];
  /** The agent lists the workloads with their pods itself: the plain workload list is not shown again. */
  hasRuntime: boolean;
}

function listSection(key: string, title: string, rows: DetailRow[], more: number, expanded: boolean, tr: Translator): SheetList {
  const toRow = (r: DetailRow, k: string): SheetRow => ({
    key: k,
    name: r.name,
    sub: r.sub,
    value: r.value,
    tone: r.tone,
    problem: r.tone === 'critical' || r.tone === 'warning',
    meta: r.meta ?? [],
    children: (r.children ?? []).map((c, j) => toRow(c, `${k}/${j}`)),
  });
  const all: SheetRow[] = rows.map((r, i) => toRow(r, `${key}/${i}`));
  const problems = all.filter((r) => r.problem);
  const healthy = all.filter((r) => !r.problem);
  const shown = expanded ? healthy : healthy.slice(0, HEALTHY_SHOWN);
  const folded = healthy.length - shown.length;
  return {
    key,
    kind: 'list',
    title,
    rows: [...problems, ...shown],
    folded,
    more,
    expandLabel: tr.t('module.showAll', { n: all.length }),
    problems: problems.length,
    count: problems.length > 0 ? tr.t('module.sectionProblems', { problems: problems.length, total: all.length }) : String(all.length + more),
  };
}

/**
 * The module sheet as it is shown: a row of key figures (at most four; what an
 * older agent sends beyond that becomes a list), then the module's objects,
 * problems first and healthy rows folded after five.
 */
export function buildSheetView(m: ModuleView, expanded: ReadonlySet<string>, tr: Translator): SheetView {
  const figures = m.stats.slice(0, 4);
  const overflow = m.stats.slice(4);
  const sections: SheetSection[] = (m.details ?? []).map((d, i) => {
    const key = `d${i}`;
    if (d.kind === 'table') {
      const rank: Record<Tone, number> = { critical: 0, warning: 1, muted: 2, ok: 3 };
      const rows = d.rows.map((r, j) => ({ key: `${key}/${j}`, cells: r.cells, tone: r.tone })).sort((a, b) => rank[a.tone] - rank[b.tone]);
      return { key, kind: 'table', title: d.title, columns: d.columns, rows, more: d.more ?? 0, count: String(d.rows.length + (d.more ?? 0)) };
    }
    return listSection(key, d.title, d.rows, d.more ?? 0, expanded.has(key), tr);
  });
  if (m.instances?.length) {
    const rows: DetailRow[] = m.instances
      .map((x) => ({
        name: `${x.namespace}/${x.name}`,
        sub: x.version,
        value: `${x.ready}/${x.desired}`,
        tone: (x.desired > 0 && x.ready === 0 ? 'critical' : x.ready < x.desired ? 'warning' : 'ok') as Tone,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
    sections.unshift(listSection('instances', tr.t('module.instances'), rows, 0, expanded.has('instances'), tr));
  }
  if (overflow.length > 0) {
    const rows: DetailRow[] = overflow.map((s) => ({ name: s.label, value: s.value, tone: s.tone ?? 'muted' }));
    sections.push(listSection('figures', tr.t('module.moreFigures'), rows, 0, true, tr));
  }
  return {
    meta: (m.instances?.length ?? 0) > 1 ? '' : [m.version, m.namespace].filter(Boolean).join(', '),
    figures,
    columns: figures.length,
    hasRuntime: (m.details ?? []).some((d) => d.kind === 'list' && d.role === 'runtime'),
    longLabels: figures.some((f) => f.label.length > 13 || f.value.length > 9),
    sections,
  };
}
