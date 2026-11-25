import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseAllDocuments } from 'yaml';

/**
 * The deployment side of the security review (M1, M4, LOW). Helm renders
 * the chart in CI; these checks keep install.yaml and the chart's templates
 * from losing the hardening without a Helm binary. The CEL of the policies
 * was evaluated against allowed and forbidden requests with cel-go while it
 * was written; a real API server has not run it (docs/PERMISSIONS.md).
 */
const DEPLOY = join(__dirname, '../../deploy');
const chart = (file: string) => readFileSync(join(DEPLOY, 'helm/kubernanny', file), 'utf8');
const install = parseAllDocuments(readFileSync(join(DEPLOY, 'install.yaml'), 'utf8')).map((d) => d.toJS() as Record<string, any>);

describe('admission policy for the agent (security review M4)', () => {
  const policies = install.filter((d) => d?.kind === 'ValidatingAdmissionPolicy');
  const bindings = install.filter((d) => d?.kind === 'ValidatingAdmissionPolicyBinding');

  it('covers every resource a write action patches or creates, for the agent only, failing closed', () => {
    const resources = policies.flatMap((p) => p.spec.matchConstraints.resourceRules.flatMap((r: { apiGroups: string[]; resources: string[] }) => r.resources.map((x) => `${r.apiGroups[0]}/${x}`)));
    expect(resources.sort()).toEqual(['apps/daemonsets', 'apps/deployments', 'apps/statefulsets', 'argoproj.io/applications', 'postgresql.cnpg.io/backups']);
    for (const p of policies) {
      expect(p.spec.failurePolicy).toBe('Fail');
      expect(p.spec.matchConditions[0].expression).toBe('request.userInfo.username == "system:serviceaccount:kubernanny:kubernanny"');
      expect(p.spec.matchConstraints.resourceRules[0].operations.sort()).toEqual(['CREATE', 'DELETE', 'UPDATE']);
    }
  });

  it('binds every policy with Deny', () => {
    expect(bindings.map((b) => b.spec.policyName).sort()).toEqual(policies.map((p) => p.metadata.name).sort());
    expect(bindings.every((b) => b.spec.validationActions.join() === 'Deny')).toBe(true);
  });

  it('allows a restart only through the restartedAt annotation and a sync without another source', () => {
    const restart = JSON.stringify(policies.find((p) => p.metadata.name === 'kubernanny-restart-deployments'));
    expect(restart).toContain('object.spec.template.spec == oldObject.spec.template.spec');
    expect(restart).toContain('kubectl.kubernetes.io/restartedAt');
    const argo = JSON.stringify(policies.find((p) => p.metadata.name === 'kubernanny-argocd-applications'));
    for (const field of ['revision', 'revisions', 'source', 'sources', 'manifests']) {
      expect(argo).toContain(`object.operation.?sync.?${field} == optional.none()`);
    }
  });

  it('is rendered by the chart only on clusters that have the API, and while a write action is on', () => {
    const template = chart('templates/admission-policy.yaml');
    expect(template).toContain('.Capabilities.APIVersions.Has "admissionregistration.k8s.io/v1/ValidatingAdmissionPolicy"');
    expect(template).toContain('.Values.rbac.admissionPolicy.enabled');
    expect(template).toContain('kubernanny.enabledWriteActions');
    expect(chart('values.yaml')).toMatch(/admissionPolicy:\n\s+enabled: true/);
  });
});

describe('chart hardening (security review H3, M1, M2, LOW)', () => {
  const deployment = chart('templates/deployment.yaml');

  it('renders no notification channel when notifications are switched off for good', () => {
    const locked = deployment.slice(deployment.indexOf('if not $notificationsLocked'));
    expect(locked.indexOf('NTFY_URL')).toBeGreaterThan(0);
    expect(deployment.indexOf('NTFY_URL')).toBeGreaterThan(deployment.indexOf('if not $notificationsLocked'));
  });

  it('reads only NTFY_TOKEN and WEBHOOK_URL from the existing Secret, never the whole Secret', () => {
    expect(deployment).not.toContain('envFrom');
    expect(deployment).toContain('key: NTFY_TOKEN');
    expect(deployment).toContain('key: WEBHOOK_URL');
  });

  it('validates the hard switches against the generated lists', () => {
    expect(deployment).toContain('include "kubernanny.validateSwitches"');
    const rbac = JSON.parse(chart('files/rbac.json')) as { knownModules: string[]; actionTypes: string[] };
    expect(rbac.knownModules).toEqual(expect.arrayContaining(['notifications', 'prometheus', 'vulnerabilities', 'argocd']));
    expect(rbac.actionTypes).toEqual(['argocd-refresh', 'argocd-sync', 'cnpg-backup', 'logs', 'restart']);
  });

  it('can limit the API-server egress rule to its addresses', () => {
    expect(chart('templates/networkpolicy.yaml')).toContain('.Values.networkPolicy.egress.apiServerCIDRs');
    expect(chart('values.yaml')).toContain('apiServerCIDRs: []');
  });

  it('runs the pod with a group, in the chart and in install.yaml', () => {
    expect(deployment).toContain('runAsGroup: 1000');
    const pod = install.find((d) => d?.kind === 'Deployment')!.spec.template.spec;
    expect(pod.securityContext.runAsGroup).toBe(1000);
  });
});
