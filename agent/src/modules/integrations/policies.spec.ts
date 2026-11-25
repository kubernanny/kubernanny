import { describe, expect, it } from 'vitest';
import { de, en } from '../../testing/i18n';
import { Constraint, ConstraintTemplate, evaluateGatekeeper } from './gatekeeper';
import { enforces, evaluateKyverno, KyvernoPolicy, PolicyReport } from './kyverno';

const policy = (name: string, mode: string, ready = 'True', namespace?: string): KyvernoPolicy => ({
  metadata: { name, namespace },
  spec: { validationFailureAction: mode },
  status: { conditions: [{ type: 'Ready', status: ready, message: ready === 'True' ? undefined : 'rule failed to compile' }] },
});
const report = (...results: [string, string][]): PolicyReport => ({ metadata: { name: 'r', namespace: 'default' }, results: results.map(([p, result]) => ({ policy: p, result, message: `${p} says no` })) });

describe('evaluateKyverno', () => {
  it('turns violations into hints, one per policy, and ignores passes', () => {
    const issues = evaluateKyverno([report(['disallow-latest', 'fail'], ['disallow-latest', 'fail'], ['restrict', 'pass'])], [policy('disallow-latest', 'Enforce'), policy('restrict', 'Enforce')]);
    expect(issues.map((i) => [i.id, i.severity])).toEqual([['kyverno/policy/disallow-latest', 'info']]);
    expect(de(issues[0]!.title)).toBe('Richtlinie disallow-latest: 2 Verstöße');
    expect(en(issues[0]!.cause)).toBe('2 resources violate it. disallow-latest says no');
  });

  it('warns only when an enforcing policy reports errors of the engine', () => {
    const issues = evaluateKyverno([report(['enf', 'error'], ['audit', 'error'])], [policy('enf', 'Enforce'), policy('audit', 'Audit')]);
    expect(issues.map((i) => [i.id, i.severity])).toEqual([
      ['kyverno/policy/audit', 'info'],
      ['kyverno/policy/enf', 'warning'],
    ]);
  });

  it('warns about an enforcing policy that is not ready, not about an auditing one', () => {
    const issues = evaluateKyverno([], [policy('enf', 'Enforce', 'False', 'shop'), policy('audit', 'Audit', 'False')]);
    expect(issues.map((i) => [i.id, i.severity, en(i.cause)])).toEqual([['kyverno/policy/shop/enf/not-ready', 'warning', 'rule failed to compile']]);
  });

  it('reads the mode per rule (Kyverno 1.13 on) too', () => {
    expect(enforces({ metadata: { name: 'p' }, spec: { rules: [{ validate: { failureAction: 'Enforce' } }] } })).toBe(true);
    expect(enforces({ metadata: { name: 'p' }, spec: { validationFailureAction: 'audit' } })).toBe(false);
  });
});

describe('evaluateGatekeeper', () => {
  const template = (kind: string, error?: string): ConstraintTemplate => ({ metadata: { name: kind.toLowerCase() }, spec: { crd: { spec: { names: { kind } } } }, status: { byPod: [{ id: 'audit', errors: error ? [{ code: 'ingest_error', message: error }] : [] }] } });
  const constraint = (kind: string, name: string, action: string | undefined, totalViolations: number): Constraint => ({ kind, metadata: { name }, spec: { enforcementAction: action }, status: { totalViolations, violations: [{ message: 'you must provide labels: {"owner"}' }] } });

  it('hints at violations and stays quiet without', () => {
    const issues = evaluateGatekeeper([template('K8sRequiredLabels')], [constraint('K8sRequiredLabels', 'owner', 'dryrun', 3), constraint('K8sRequiredLabels', 'team', undefined, 0)]);
    expect(issues.map((i) => [i.id, i.severity])).toEqual([['gatekeeper/K8sRequiredLabels/owner', 'info']]);
    expect(en(issues[0]!.cause)).toBe('Found by the audit; the constraint only reports (dryrun or warn). you must provide labels: {"owner"}');
  });

  it('warns when a denying constraint cannot work because its template has errors', () => {
    const issues = evaluateGatekeeper([template('K8sRequiredLabels', 'rego parse error')], [constraint('K8sRequiredLabels', 'owner', undefined, 0), constraint('K8sRequiredLabels', 'audit-only', 'warn', 0)]);
    expect(issues.map((i) => [i.id, i.severity])).toEqual([['gatekeeper/K8sRequiredLabels/owner/errors', 'warning']]);
    expect(en(issues[0]!.cause)).toContain('rego parse error');
  });
});
