import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse, parseAllDocuments } from 'yaml';
import { CORE_CHECKS } from './modules/core';
import { INTEGRATIONS } from './modules/integrations';
import { INVENTORY_READS, NAMESPACE_ROLE, NEVER, RbacRule, WRITE_EFFECTS } from './rbac/permissions';
import { fillSections, permissionSections } from './rbac/permissions-doc';
import { rbacExport } from './rbac/rules';
import { SWITCHES } from './rbac/switches';
import { ACTION_TYPES } from './settings/settings.service';
import { render } from './i18n/text';

const ROOT = join(__dirname, '../..');
const DOC = join(ROOT, 'docs/PERMISSIONS.md');
const CHART = join(ROOT, 'deploy/helm/kubernanny');

/** Every key path of values.yaml ("relay.enabled", "checks.disabled", …). */
function valuePaths(): Set<string> {
  const out = new Set<string>();
  const walk = (o: unknown, prefix: string) => {
    if (o && typeof o === 'object' && !Array.isArray(o)) {
      for (const [k, v] of Object.entries(o)) {
        const path = prefix ? `${prefix}.${k}` : k;
        out.add(path);
        walk(v, path);
      }
    }
  };
  walk(parse(readFileSync(join(CHART, 'values.yaml'), 'utf8')), '');
  return out;
}

const sections = permissionSections(valuePaths());
if (process.env['UPDATE_DOCS']) {
  writeFileSync(DOC, fillSections(readFileSync(DOC, 'utf8'), sections));
}

type Kind = 'ClusterRole' | 'Role';

/** The template's Roles as written: its static lines only (the `{{ range }}` lines are left out). */
function templateRoles(): { kind: Kind; rules: RbacRule[] }[] {
  const raw = readFileSync(join(CHART, 'templates/rbac.yaml'), 'utf8')
    .split('\n')
    .filter((l) => !/^\s*\{\{-?/.test(l))
    .join('\n')
    .replace(/\{\{[^}]*\}\}/g, 'x');
  return parseAllDocuments(raw)
    .map((d) => d.toJS())
    .filter((d) => d?.kind === 'ClusterRole' || d?.kind === 'Role')
    .map((d) => ({ kind: d.kind as Kind, rules: ((d.rules ?? []) as RbacRule[]).filter((r) => !r.apiGroups.includes('x')) }));
}

function staticClusterRules(): RbacRule[] {
  return templateRoles().find((r) => r.kind === 'ClusterRole')!.rules;
}

/** The chart with every module and action switched on: the static lines plus files/rbac.json. */
function chartRules(): { kind: Kind; rules: RbacRule[] }[] {
  const roles = templateRoles();
  const generated = rbacExport();
  const dynamic = [...Object.values(generated.modules).flat(), ...Object.values(generated.actions).flatMap((a) => a.rules)];
  roles.find((r) => r.kind === 'ClusterRole')!.rules.push(...dynamic.map((r) => ({ apiGroups: [r.group], resources: r.resources, verbs: r.verbs })));
  return roles;
}

function installRoles(): { kind: Kind; rules: RbacRule[] }[] {
  return parseAllDocuments(readFileSync(join(ROOT, 'deploy/install.yaml'), 'utf8'))
    .map((d) => d.toJS())
    .filter((d) => d?.kind === 'ClusterRole' || d?.kind === 'Role')
    .map((d) => ({ kind: d.kind as Kind, rules: d.rules as RbacRule[] }));
}

const flat = (rules: RbacRule[]) => rules.flatMap((r) => r.apiGroups.flatMap((g) => r.resources.flatMap((x) => r.verbs.map((v) => `${g}/${x}:${v}`)))).sort();

describe('docs/PERMISSIONS.md', () => {
  it('is up to date with the code and the chart (run `npm run docs:permissions`)', () => {
    const doc = readFileSync(DOC, 'utf8');
    expect(doc).toEqual(fillSections(doc, sections));
  });

  it('lists every switch of values.yaml in the "switch -> what is removed" matrix', () => {
    const paths = valuePaths();
    const switches = [...paths].filter((p) => /(^|\.)(enabled|disabled|allow[A-Z]\w*)$/.test(p));
    expect(switches.length).toBeGreaterThan(5);
    const listed = new Set(SWITCHES.map((s) => s.value));
    expect(switches.filter((p) => !listed.has(p))).toEqual([]);
    // A row for a value the chart no longer has would describe a switch nobody can set.
    expect(SWITCHES.map((s) => s.value).filter((v) => !paths.has(v))).toEqual([]);
  });

  it('gives every module read a short reason', () => {
    for (const m of [...CORE_CHECKS, ...INTEGRATIONS]) {
      for (const r of m.reads) {
        expect(r.why.trim().length, `${m.id} ${r.resource}`).toBeGreaterThan(5);
        expect(r.why.length, `${m.id} ${r.resource}`).toBeLessThanOrEqual(90);
      }
    }
  });

  it('describes write actions with what actions.service.ts (and rollback.service.ts) really sends', () => {
    const source = ['actions/actions.service.ts', 'actions/rollback.service.ts'].map((f) => readFileSync(join(__dirname, f), 'utf8')).join('\n');
    for (const [type, effect] of Object.entries(WRITE_EFFECTS)) {
      expect(source, type).toContain(effect.marker);
    }
    expect(Object.keys(WRITE_EFFECTS).sort()).toEqual([...rbacExport().writeActions].sort());
  });

  it('describes exactly the static ClusterRole lines (the inventory) of the chart and install.yaml', () => {
    const documented = INVENTORY_READS.map((r) => ({ apiGroups: [r.group], resources: r.resources, verbs: r.verbs }));
    expect(flat(staticClusterRules())).toEqual(flat(documented));
    const install = new Set(flat(installRoles().find((r) => r.kind === 'ClusterRole')!.rules));
    expect(flat(documented).filter((x) => !install.has(x))).toEqual([]);
  });

  it('describes exactly the Role in the agent\'s own namespace', () => {
    const documented = NAMESPACE_ROLE.map((r) => ({ apiGroups: [r.group ?? ''], resources: r.resources, verbs: r.verbs, resourceNames: r.names }));
    const key = (rules: RbacRule[]) => rules.map((r) => `${flat([r]).join(',')}|${(r.resourceNames ?? []).join(',')}`).sort();
    expect(key(installRoles().find((r) => r.kind === 'Role')!.rules)).toEqual(key(documented));
    expect(key(chartRules().find((r) => r.kind === 'Role')!.rules)).toEqual(key(documented));
  });

  it('never grants what the page says it never has, with every module and action switched on', () => {
    for (const { kind, rules } of [...chartRules(), ...installRoles()]) {
      for (const rule of rules) {
        for (const never of NEVER) {
          expect(never.matches(rule, kind), `${kind} ${JSON.stringify(rule)}: ${never.what}`).toBe(false);
        }
      }
    }
  });

  it('tells the app in both languages what each action may change', () => {
    for (const a of ACTION_TYPES) {
      for (const lang of ['en', 'de'] as const) {
        expect(render(a.effect, lang).length, `${a.type} ${lang}`).toBeGreaterThan(20);
        expect(render(a.effect, lang)).not.toMatch(/[\u2013\u2014]/);
      }
    }
  });

  it('would catch a forbidden rule (the predicates are not vacuous)', () => {
    const bad: [RbacRule, Kind][] = [
      [{ apiGroups: [''], resources: ['pods'], verbs: ['deletecollection'] }, 'ClusterRole'],
      [{ apiGroups: ['apps'], resources: ['deployments'], verbs: ['delete'] }, 'ClusterRole'],
      [{ apiGroups: [''], resources: ['nodes'], verbs: ['delete'] }, 'ClusterRole'],
      [{ apiGroups: [''], resources: ['pods'], verbs: ['create'] }, 'ClusterRole'],
      [{ apiGroups: [''], resources: ['secrets'], verbs: ['get'] }, 'ClusterRole'],
      [{ apiGroups: [''], resources: ['services/proxy'], verbs: ['get'] }, 'ClusterRole'],
      [{ apiGroups: [''], resources: ['pods/exec'], verbs: ['create'] }, 'ClusterRole'],
      [{ apiGroups: ['rbac.authorization.k8s.io'], resources: ['clusterroles'], verbs: ['escalate'] }, 'ClusterRole'],
      [{ apiGroups: [''], resources: ['secrets'], verbs: ['get'] }, 'Role'],
      [{ apiGroups: ['*'], resources: ['*'], verbs: ['get'] }, 'ClusterRole'],
      [{ apiGroups: ['constraints.gatekeeper.sh'], resources: ['*'], verbs: ['patch'] }, 'ClusterRole'],
    ];
    for (const [rule, kind] of bad) {
      expect(NEVER.some((n) => n.matches(rule, kind)), JSON.stringify(rule)).toBe(true);
    }
  });
});
