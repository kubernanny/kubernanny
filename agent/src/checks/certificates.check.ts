import { raw, t } from '../i18n/text';
import { Condition, Issue, ObjectMeta, ageText, condition } from './types';

export interface Certificate {
  metadata: ObjectMeta;
  spec?: { secretName?: string; dnsNames?: string[] };
  status?: { conditions?: Condition[]; notAfter?: string; renewalTime?: string };
}

export interface CertificateOptions {
  /** cert-manager renews a 90-day certificate 30 days before expiry, so under 14 days its renewal is failing. */
  warnDays: number;
  criticalDays: number;
}

export function evaluateCertificates(certs: Certificate[], now: Date, opts: CertificateOptions): Issue[] {
  const issues: Issue[] = [];
  for (const cert of certs) {
    const ns = cert.metadata.namespace ?? 'default';
    const name = cert.metadata.name;
    const id = `certificates/${ns}/${name}`;
    const host = cert.spec?.dnsNames?.[0] ?? name;
    const notAfter = Date.parse(cert.status?.notAfter ?? '');
    const left = notAfter - now.getTime();

    if (Number.isFinite(notAfter) && left <= 0) {
      issues.push({
        id,
        check: 'certificates',
        severity: 'critical',
        title: t('certificates.expired.title', { host }),
        cause: t('certificates.expired.cause', { age: ageText(-left), message: condition(cert.status?.conditions, 'Ready')?.message }),
        actions: [],
      });
      continue;
    }

    const ready = condition(cert.status?.conditions, 'Ready');
    if (ready && ready.status !== 'True') {
      const issuing = condition(cert.status?.conditions, 'Issuing');
      const message = [ready.message, issuing?.status === 'True' ? issuing.message : undefined].filter(Boolean).join(' ');
      issues.push({
        id,
        check: 'certificates',
        severity: Number.isFinite(left) && left < opts.criticalDays * 86_400_000 ? 'critical' : 'warning',
        title: t('certificates.notReady.title', { host }),
        cause: message ? raw(message) : t('certificates.notReady.cause'),
        actions: [],
      });
      continue;
    }

    if (Number.isFinite(notAfter) && left < opts.warnDays * 86_400_000) {
      issues.push({
        id,
        check: 'certificates',
        severity: left < opts.criticalDays * 86_400_000 ? 'critical' : 'warning',
        title: t('certificates.expiring.title', { host, age: ageText(left) }),
        cause: t('certificates.expiring.cause', { planned: cert.status?.renewalTime?.slice(0, 10) }),
        actions: [],
      });
    }
  }
  return issues;
}
