import { ActionType, OPT_IN_ACTIONS } from '../checks/types';
import { CATALOG } from '../discovery/catalog';
import type { Config } from '../config';
import { render } from '../i18n/text';
import { CORE_CHECKS } from '../modules/core';
import { INTEGRATIONS } from '../modules/integrations';
import { CheckModule, CoreCheck } from '../modules/module';
import { INVENTORY_READS, NAMESPACE_ROLE, NEVER, WRITE_EFFECTS, WriteActionType } from './permissions';
import { Rule, WRITE_ACTIONS, rbacExport } from './rules';
import { SWITCHES } from './switches';

/**
 * The generated parts of docs/PERMISSIONS.md, by section name. Each lands
 * between `<!-- generated:<name> -->` and `<!-- /generated:<name> -->`; the
 * prose around them is written by hand. `npm run docs:permissions` rewrites
 * them, and `permissions-doc.spec.ts` fails while the file differs.
 */
export function permissionSections(valuesPaths: ReadonlySet<string>): Record<string, string> {
  return {
    write: writeTable(),
    modules: moduleTable(),
    inventory: inventoryTable(),
    role: roleTable(),
    never: NEVER.map((n) => `- ${n.what}`).join('\n'),
    switches: switchMatrix(valuesPaths),
  };
}

/** Replaces every generated section of `doc`; throws when a marker pair is missing, so a section cannot silently vanish. */
export function fillSections(doc: string, sections: Record<string, string>): string {
  let out = doc;
  for (const [name, body] of Object.entries(sections)) {
    const re = new RegExp(`(<!-- generated:${name} -->\\n)[\\s\\S]*?(<!-- /generated:${name} -->)`);
    if (!re.test(out)) {
      throw new Error(`docs/PERMISSIONS.md lacks the markers of section "${name}"`);
    }
    out = out.replace(re, (_m, open: string, close: string) => `${open}${body}\n${close}`);
  }
  return out;
}

const code = (s: string) => `\`${s}\``;
const resource = (group: string, name: string) => code(group ? `${group}/${name}` : name);
const ruleText = (r: Rule) => `${r.verbs.join(', ')} ${r.resources.map((x) => resource(r.group, x)).join(', ')}`;

/** The defaults the page describes (a mirror changes only the host). */
const DOC_CONFIG = { vulnDbUrl: 'https://api.osv.dev' } as Config;

/** What a module sends out of the cluster, in its own words (the text next to its switch in the app). */
function outboundOf(m: CheckModule): string | undefined {
  if (m instanceof CoreCheck) {
    const privacy = m.privacy(DOC_CONFIG);
    return privacy ? render(privacy, 'en') : undefined;
  }
  return 'untrusted' in m && m.untrusted ? `plain HTTP GET to ${moduleName(m)} over cluster DNS; its answers never carry actions` : undefined;
}

function moduleName(m: CheckModule): string {
  return m instanceof CoreCheck ? render(m.name, 'en') : (CATALOG.find((e) => e.id === m.id)?.name ?? m.id);
}

/** Actions whose permission another enabled action shares: disabling one alone keeps the rule. */
function sharedWith(type: ActionType): ActionType[] {
  const key = (r: Rule) => `${r.group}|${r.resources.join(',')}|${r.verbs.join(',')}`;
  const mine = new Set(rbacExport().actions[type]!.rules.map(key));
  return (Object.entries(rbacExport().actions) as [ActionType, { rules: Rule[] }][])
    .filter(([other, g]) => other !== type && g.rules.some((r) => mine.has(key(r))))
    .map(([other]) => other);
}

function impossible(type: ActionType): string {
  const shared = sharedWith(type);
  const grant = rbacExport().actions[type]!;
  const modules = grant.modules.map(code).join(', ');
  // Opt-in actions are off unless enabled, so they keep a shared rule only when someone switched them on.
  const sharedOn = shared.filter((s) => !OPT_IN_ACTIONS.includes(s));
  const sharedOptIn = shared.filter((s) => OPT_IN_ACTIONS.includes(s));
  const optInNote = sharedOptIn.length ? ` (and ${sharedOptIn.map(code).join(', ')} not named in ${code('actions.enabled')}, as by default)` : '';
  const rule = sharedOn.length
    ? `removes the rule only together with ${sharedOn.map((s) => code(`actions.disabled: [${s}]`)).join(', ')}${optInNote}, or with ${code('checks.disabled')} for ${modules}`
    : shared.length
      ? `removes the rule${optInNote}; so does ${code('checks.disabled')} for ${modules}`
    : `removes the rule; so does ${code('checks.disabled')} for ${grant.modules.length > 1 ? `all of ${modules}` : modules}`;
  const all = WRITE_ACTIONS.includes(type) ? `, or ${code('rbac.allowActions: false')} for every write action` : '';
  const optIn = OPT_IN_ACTIONS.includes(type) ? `Off by default: leave it out of ${code('actions.enabled')} (the default). Also ` : '';
  return `${optIn}${code(`actions.disabled: [${type}]`)}: the route answers 403 and ${rule}${all}`;
}

function writeTable(): string {
  const rows = (Object.keys(WRITE_EFFECTS) as WriteActionType[]).map((type) => {
    const grant = rbacExport().actions[type]!;
    return `| ${code(type)} | ${grant.rules.map(ruleText).join('; ')} | ${WRITE_EFFECTS[type].changes} | ${WRITE_EFFECTS[type].admission} | ${grant.modules.map(code).join(', ')} | ${impossible(type)} |`;
  });
  return [
    '| Action | Verb and resource | What exactly it changes | What the admission policy still allows the ServiceAccount (Kubernetes 1.30+) | Offered by | How to make it impossible |',
    '|---|---|---|---|---|---|',
    ...rows,
  ].join('\n');
}

function moduleTable(): string {
  const rows = [...CORE_CHECKS, ...INTEGRATIONS].map((m) => {
    const onByDefault = m instanceof CoreCheck ? (m.defaultOff ? 'no (switch on in the app or Helm)' : 'yes') : 'when detected';
    const reads = m.reads.length ? m.reads.map((r) => `get, list ${resource(r.group, r.resource)}: ${r.why}`).join('<br>') : 'nothing of its own (the inventory)';
    const other = [outboundOf(m)].filter((o) => o !== undefined);
    const actions = m.actions.length ? m.actions.map(code).join(', ') : '';
    const sole = (Object.entries(rbacExport().actions) as [ActionType, { modules: string[] }][]).filter(([, g]) => g.modules.length === 1 && g.modules[0] === m.id).map(([type]) => code(type));
    const removed = [m.reads.length ? 'its RBAC rules' : '', sole.length ? `the permissions of ${sole.join(', ')}` : '', other.length ? 'its outbound requests' : '', 'its issues'].filter(Boolean).join(', ');
    return `| ${code(m.id)} | ${moduleName(m)} | ${onByDefault} | ${reads} | ${actions} | ${other.join('; ')} | ${code(`checks.disabled: [${m.id}]`)}: not run; removes ${removed} |`;
  });
  return ['| Id | Module | On by default | Reads, and why | Offers | Other access | How to make it impossible |', '|---|---|---|---|---|---|---|', ...rows].join('\n');
}

function inventoryTable(): string {
  return ['| Resources | Verbs | Why |', '|---|---|---|', ...INVENTORY_READS.map((r) => `| ${r.resources.map((x) => resource(r.group, x)).join(', ')} | ${r.verbs.join(', ')} | ${r.why} |`)].join('\n');
}

function roleTable(): string {
  return ['| Resources | Names | Verbs | What for |', '|---|---|---|---|', ...NAMESPACE_ROLE.map((r) => `| ${r.resources.join(', ')} | ${r.names.map(code).join(', ') || 'any (see why)'} | ${r.verbs.join(', ')} | ${r.holds} |`)].join('\n');
}

function switchMatrix(valuesPaths: ReadonlySet<string>): string {
  const head = ['| Switch | Hard | RBAC removed | Routes refused | Outbound removed | Other |', '|---|---|---|---|---|---|'];
  const cell = (s?: string) => s ?? '';
  const general = SWITCHES.filter((s) => valuesPaths.has(s.value)).map((s) => `| ${code(s.set)} | ${s.hard ? 'yes' : 'no'} | ${cell(s.rbac)} | ${cell(s.routes)} | ${cell(s.outbound)} | ${cell(s.other)} |`);
  const exported = rbacExport();
  const actions = (Object.keys(exported.actions) as ActionType[]).map((type) => {
    const shared = sharedWith(type);
    const rules = exported.actions[type]!.rules.map(ruleText).join('; ');
    const rbac = shared.length ? `${rules}, once ${shared.map(code).join(', ')} is disabled too` : rules;
    const route =
      type === 'logs'
        ? '`GET /api/logs` answers 403 `ACTION_DISABLED`'
        : type === 'argocd-rollback'
          ? '`POST /api/argocd/rollback` answers 403 `ACTION_DISABLED`'
          : `${code(`POST /api/actions/${type}`)} answers 403 ${code('ACTION_DISABLED')}`;
    return `| ${code(`actions.disabled: [${type}]`)} | yes | ${rbac} | ${route} | | |`;
  });
  const modules = [...CORE_CHECKS, ...INTEGRATIONS]
    .filter((m) => m.reads.length > 0 || outboundOf(m) !== undefined || m.actions.length > 0)
    .map((m) => {
      const own = exported.modules[m.id]?.map(ruleText) ?? [];
      const onlyHere = (Object.entries(exported.actions) as [ActionType, { modules: string[]; rules: Rule[] }][])
        .filter(([, g]) => g.modules.length === 1 && g.modules[0] === m.id)
        .map(([type]) => code(type));
      const rbac = [...own, ...(onlyHere.length ? [`the permissions of ${onlyHere.join(', ')}`] : [])].join('; ');
      // findPrometheus: the hard switch takes the client away from every module and view, not only this one.
      const outbound =
        m.id === 'prometheus'
          ? 'every request to Prometheus, from every module and view (nodes, volumes, etcd, clocks, ingress error rates, history)'
          : outboundOf(m)
            ? m instanceof CoreCheck
              ? `its requests out of the cluster (${moduleName(m)})`
              : `HTTP to ${moduleName(m)}`
            : '';
      const routes = m.id === 'vulnerabilities' ? '`POST /api/vulnerabilities/accept` and `/unaccept` answer 403' : '';
      return `| ${code(`checks.disabled: [${m.id}]`)} | yes | ${rbac} | ${routes} | ${outbound} | not run, no issues |`;
    });
  const rest = `| ${code('checks.disabled: [<any other id>]')} | yes | | | | not run, no issues (nothing of its own in the ClusterRole) |`;
  return [...head, ...general, ...actions, ...modules, rest].join('\n');
}
