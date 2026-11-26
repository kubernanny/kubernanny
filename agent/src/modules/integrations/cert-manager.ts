import { Certificate, evaluateCertificates } from '../../checks/certificates.check';
import { ageText, condition, Issue } from '../../checks/types';
import { rawOr, t } from '../../i18n/text';
import { AcmeChallenge, certificateDetails } from '../details';
import { Integration } from '../module';
import { ModuleContext, ModuleResult, Stat } from '../types';
import { Conditioned } from './util';

interface Issuer extends Conditioned {
  kind?: string;
}

export class CertManagerIntegration extends Integration {
  readonly id = 'cert-manager';
  override readonly actions = ['reconcile-now'] as const;
  readonly reads = [
    { group: 'cert-manager.io', resource: 'certificates', why: 'expiry and Ready condition of every certificate' },
    { group: 'cert-manager.io', resource: 'clusterissuers', why: 'whether the issuers are ready' },
    {
      group: 'acme.cert-manager.io',
      resource: 'challenges',
      why: 'ACME challenges still open, with their state and reason, for the sheet',
    },
  ];
  protected async inspect(ctx: ModuleContext): Promise<ModuleResult> {
    const [certs, issuers, challenges] = await Promise.all([
      ctx.kube.list<Certificate>('/apis/cert-manager.io/v1/certificates'),
      ctx.kube.list<Issuer>('/apis/cert-manager.io/v1/clusterissuers').catch(() => null),
      ctx.kube.list<AcmeChallenge>('/apis/acme.cert-manager.io/v1/challenges').catch(() => null),
    ]);
    ctx.data.certificates = certs ?? [];
    const issues: Issue[] = evaluateCertificates(certs ?? [], ctx.now, {
      warnDays: ctx.config.certWarnDays,
      criticalDays: ctx.config.certCriticalDays,
    });
    for (const issuer of issuers ?? []) {
      const ready = condition(issuer.status?.conditions, 'Ready');
      if (ready && ready.status !== 'True') {
        issues.push({
          id: `certificates/issuer/${issuer.metadata.name}`,
          check: 'certificates',
          severity: 'critical',
          title: t('certificates.issuer.title', { issuer: issuer.metadata.name }),
          cause: rawOr(ready.message, t('certificates.issuer.cause')),
          actions: [],
        });
      }
    }
    const expiries = (certs ?? [])
      .map((c) => ({ c, t: Date.parse(c.status?.notAfter ?? '') }))
      .filter((x) => Number.isFinite(x.t))
      .sort((a, b) => a.t - b.t);
    const next = expiries[0];
    const ready = (certs ?? []).filter((c) => condition(c.status?.conditions, 'Ready')?.status === 'True').length;
    const stats: Stat[] = [
      {
        label: t('certificates.stat.ready'),
        value: `${ready}/${certs?.length ?? 0}`,
        tone: ready === certs?.length ? 'ok' : 'warning',
      },
      { label: t('certificates.stat.issuers'), value: String(issuers?.length ?? 0) },
    ];
    if (next) {
      stats.push({
        label: t('certificates.stat.nextExpiry'),
        value: t('certificates.nextExpiry', {
          host: next.c.spec?.dnsNames?.[0] ?? next.c.metadata.name,
          age: ageText(next.t - ctx.now.getTime()),
        }),
        tone: next.t - ctx.now.getTime() < ctx.config.certWarnDays * 86_400_000 ? 'warning' : 'ok',
      });
    }
    const details = certificateDetails(
      certs ?? [],
      issuers ?? [],
      ctx.now,
      ctx.config.certWarnDays,
      ctx.config.certCriticalDays,
      challenges ?? [],
    );
    return {
      issues,
      stats,
      details,
      summary: issues.length === 0 ? t('certificates.summary.ok', { n: certs?.length ?? 0 }) : issues[0].title,
    };
  }
}
