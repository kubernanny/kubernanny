import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';
import { parseAllDocuments } from 'yaml';

import { BASELINE_CAPABILITIES, BASELINE_SELINUX_TYPES, BASELINE_SYSCTLS } from './actions/pod-security';

/**
 * The deployment side of the security review (M1, M4, LOW). Helm renders
 * the chart in CI; these checks keep install.yaml and the chart's templates
 * from losing the hardening without a Helm binary. The CEL of the policies
 * was evaluated against allowed and forbidden requests with cel-go while it
 * was written; a real API server has not run it (docs/PERMISSIONS.md).
 */
const DEPLOY = join(__dirname, '../../deploy');
const chart = (file: string) => readFileSync(join(DEPLOY, 'helm/kubernanny', file), 'utf8');

const install = parseAllDocuments(readFileSync(join(DEPLOY, 'install.yaml'), 'utf8')).map(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- parsed YAML that the tests read deep into
  (d) => d.toJS() as Record<string, any>,
);

describe('admission policy for the agent (security review M4)', () => {
  const policies = install.filter((d) => d?.kind === 'ValidatingAdmissionPolicy');
  const bindings = install.filter((d) => d?.kind === 'ValidatingAdmissionPolicyBinding');

  it('covers every resource a write action patches or creates, for the agent only, failing closed', () => {
    const resources = policies.flatMap((p) =>
      p.spec.matchConstraints.resourceRules.flatMap((r: { apiGroups: string[]; resources: string[] }) =>
        r.resources.map((x) => `${r.apiGroups[0]}/${x}`),
      ),
    );
    expect(resources.sort()).toEqual([
      '/nodes',
      '/pods',
      'apps/daemonsets',
      'apps/deployments',
      'apps/statefulsets',
      'argoproj.io/applications',
      'batch/jobs',
      'cert-manager.io/certificates',
      'cert-manager.io/certificates/status',
      'external-secrets.io/externalsecrets',
      'helm.toolkit.fluxcd.io/helmreleases',
      'kustomize.toolkit.fluxcd.io/kustomizations',
      'longhorn.io/backups',
      'longhorn.io/snapshots',
      'postgresql.cnpg.io/backups',
      'secrets.infisical.com/infisicalstaticsecrets',
      'velero.io/backups',
    ]);
    for (const p of policies) {
      expect(p.spec.failurePolicy).toBe('Fail');
      expect(p.spec.matchConditions[0].expression).toBe(
        'request.userInfo.username == "system:serviceaccount:kubernanny:kubernanny"',
      );
      for (const rule of p.spec.matchConstraints.resourceRules) {
        expect(rule.operations.sort()).toEqual(['CREATE', 'DELETE', 'UPDATE']);
      }
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

  it('keeps the opt-in policies and branches out of install.yaml and renders them only on opt-in', () => {
    const names = policies.map((p) => p.metadata.name);
    expect(names).not.toContain('kubernanny-pvcs');
    // The Jobs policy is there for job-delete (on by default), without job-rerun's create branch.
    const jobs = JSON.stringify(policies.find((p) => p.metadata.name === 'kubernanny-jobs'));
    expect(jobs).toContain("request.operation == 'DELETE'");
    expect(jobs).toContain("c.type == 'Failed' && c.status == 'True'");
    expect(jobs).not.toContain('manualSelector');
    expect(jobs).not.toContain('variables.pod');
    const pods = JSON.stringify(policies.find((p) => p.metadata.name === 'kubernanny-pods'));
    expect(pods).toContain("oldObject.status.?phase.orValue('') in ['Failed', 'Succeeded']");
    expect(pods).not.toContain('deletionTimestamp');
    expect(JSON.stringify(policies.find((p) => p.metadata.name === 'kubernanny-argocd-applications'))).not.toContain(
      "optional.of('Terminating')",
    );
    const template = chart('templates/admission-policy.yaml');
    expect(template).toContain('{{- $rerun := has "job-rerun" $writes }}');
    expect(template).toContain('{{- $jobDelete := has "job-delete" $writes }}');
    expect(template).toContain('{{- if has "pvc-expand" $writes }}');
    expect(template).toContain('{{- $force := has "force-delete-terminating" $writes }}');
    expect(template).toContain('{{- $terminate := has "argocd-terminate-op" $writes }}');
  });

  it("denies Velero hooks, and anything beyond the baseline Pod Security Standard in a rerun Job, with the agent's own lists", () => {
    const velero = JSON.stringify(policies.find((p) => p.metadata.name === 'kubernanny-velero-backups'));
    for (const field of ['hooks', 'resourcePolicy', 'orderedResources']) {
      expect(velero).toContain(`!has(object.spec.${field})`);
    }
    const template = chart('templates/admission-policy.yaml');
    for (const check of [
      'hostNetwork.orValue(false) == false',
      'all(v, !has(v.hostPath))',
      'privileged.orValue(false) == false',
      'allowPrivilegeEscalation.orValue(false) == false',
      'capabilities.?add.orValue([]).all(x, x in variables.capabilities)',
      "procMount.orValue('Default') == 'Default'",
      "seccompProfile.?type.orValue('') != 'Unconfined'",
      'p.?hostPort.orValue(0) == 0',
      'all(s, s.name in variables.sysctls)',
      "!k.startsWith('container.apparmor.security.beta.kubernetes.io/')",
    ]) {
      expect(template).toContain(check);
    }
    // The policy's allowlists are the agent's (actions/pod-security.ts).
    for (const value of [...BASELINE_CAPABILITIES, ...BASELINE_SYSCTLS, ...BASELINE_SELINUX_TYPES]) {
      expect(template).toContain(`'${value}'`);
    }
    // CEL's optional map index is m[?'key']; m.?['key'] does not compile in an API server.
    expect(template).not.toContain(".?['");
  });

  it('holds uncordon to spec.unschedulable and a renew to the Issuing condition', () => {
    const nodes = JSON.stringify(policies.find((p) => p.metadata.name === 'kubernanny-nodes'));
    expect(nodes).toContain('oldObject.spec.?unschedulable.orValue(false) == true');
    expect(nodes).toContain('object.spec.?taints == oldObject.spec.?taints');
    const certs = JSON.stringify(policies.find((p) => p.metadata.name === 'kubernanny-certificates'));
    expect(certs).toContain("request.subResource == 'status'");
    expect(certs).toContain('ManuallyTriggered');
  });

  it('keeps the rollback branch out of install.yaml (argocd-rollback is off by default) and renders it only on opt-in', () => {
    const argo = JSON.stringify(policies.find((p) => p.metadata.name === 'kubernanny-argocd-applications'));
    expect(argo).not.toContain('status.?history');
    const template = chart('templates/admission-policy.yaml');
    expect(template).toContain('{{- $rollback := has "argocd-rollback" $writes }}');
    expect(template).toContain('{{- if $rollback }} || (');
    expect(template).toContain('oldObject.?status.?history.orValue([]).exists(h,');
    expect(template).toContain('oldObject.?spec.?syncPolicy.?automated == optional.none()');
    const helpers = chart('templates/_helpers.tpl');
    expect(helpers).toContain('define "kubernanny.offActions"');
    expect(helpers).toContain('actions.enabled: %q cannot be enabled');
    expect(chart('values.yaml')).toMatch(/\n {2}enabled: \[\]\n/);
  });

  it('is rendered by the chart only on clusters that have the API, and while a write action is on', () => {
    const template = chart('templates/admission-policy.yaml');
    expect(template).toContain(
      '.Capabilities.APIVersions.Has "admissionregistration.k8s.io/v1/ValidatingAdmissionPolicy"',
    );
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
    expect(rbac.knownModules).toEqual(
      expect.arrayContaining(['notifications', 'prometheus', 'vulnerabilities', 'argocd']),
    );
    expect(rbac.actionTypes).toEqual([
      'argocd-refresh',
      'argocd-rollback',
      'argocd-sync',
      'argocd-sync-prune',
      'argocd-sync-replace',
      'argocd-terminate-op',
      'cleanup-pods',
      'cnpg-backup',
      'config-change-hint',
      'force-delete-terminating',
      'job-delete',
      'job-rerun',
      'logs',
      'longhorn-backup',
      'pvc-expand',
      'reconcile-now',
      'restart',
      'uncordon',
      'velero-backup',
    ]);
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
