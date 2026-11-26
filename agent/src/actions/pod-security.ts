/**
 * The Pod Security Standards "baseline" profile, for the pod template of a Job
 * the agent creates (`job-rerun`). The chart's admission policy denies the same
 * (templates/admission-policy.yaml, the jobs policy); the agent checks first so
 * a refused rerun gets a message instead of an API error. Source:
 * https://kubernetes.io/docs/concepts/security/pod-security-standards/#baseline
 */

/** Capabilities baseline allows to add. */
export const BASELINE_CAPABILITIES = [
  'AUDIT_WRITE',
  'CHOWN',
  'DAC_OVERRIDE',
  'FOWNER',
  'FSETID',
  'KILL',
  'MKNOD',
  'NET_BIND_SERVICE',
  'SETFCAP',
  'SETGID',
  'SETPCAP',
  'SETUID',
  'SYS_CHROOT',
] as const;

/** SELinux types baseline allows (besides none). */
export const BASELINE_SELINUX_TYPES = ['container_t', 'container_init_t', 'container_kvm_t', 'container_engine_t'] as const;

/** The "safe" sysctls baseline allows, up to Kubernetes 1.37. */
export const BASELINE_SYSCTLS = [
  'kernel.shm_rmid_forced',
  'net.ipv4.ip_local_port_range',
  'net.ipv4.ip_unprivileged_port_start',
  'net.ipv4.tcp_syncookies',
  'net.ipv4.ping_group_range',
  'net.ipv4.ip_local_reserved_ports',
  'net.ipv4.tcp_keepalive_time',
  'net.ipv4.tcp_fin_timeout',
  'net.ipv4.tcp_keepalive_intvl',
  'net.ipv4.tcp_keepalive_probes',
  'net.ipv4.tcp_rmem',
  'net.ipv4.tcp_wmem',
  'net.ipv4.tcp_slow_start_after_idle',
  'net.ipv4.tcp_notsent_lowat',
] as const;

interface SecurityContext {
  privileged?: boolean;
  allowPrivilegeEscalation?: boolean;
  capabilities?: { add?: string[] };
  seLinuxOptions?: { type?: string; user?: string; role?: string };
  windowsOptions?: { hostProcess?: boolean };
  procMount?: string;
  seccompProfile?: { type?: string };
  appArmorProfile?: { type?: string };
  sysctls?: { name: string }[];
}

interface Handler {
  httpGet?: { host?: string };
  tcpSocket?: { host?: string };
}

interface Container {
  securityContext?: SecurityContext;
  ports?: { hostPort?: number }[];
  livenessProbe?: Handler;
  readinessProbe?: Handler;
  startupProbe?: Handler;
  lifecycle?: { postStart?: Handler; preStop?: Handler };
}

export interface PodTemplateRisk {
  metadata?: { annotations?: Record<string, string> };
  spec?: {
    hostNetwork?: boolean;
    hostPID?: boolean;
    hostIPC?: boolean;
    volumes?: { hostPath?: unknown }[];
    securityContext?: SecurityContext;
    containers?: Container[];
    initContainers?: Container[];
    ephemeralContainers?: Container[];
  };
}

const APPARMOR_ANNOTATION = 'container.apparmor.security.beta.kubernetes.io/';

/** The security context fields both pod and container level have. */
function contextRisk(sc: SecurityContext | undefined): string | null {
  if (!sc) {
    return null;
  }
  if (sc.windowsOptions?.hostProcess === true) {
    return 'windowsOptions.hostProcess';
  }
  const se = sc.seLinuxOptions;
  if (se && ((se.type && !(BASELINE_SELINUX_TYPES as readonly string[]).includes(se.type)) || se.user || se.role)) {
    return 'seLinuxOptions';
  }
  if (sc.seccompProfile?.type === 'Unconfined') {
    return 'seccompProfile Unconfined';
  }
  if (sc.appArmorProfile?.type !== undefined && sc.appArmorProfile.type !== 'RuntimeDefault' && sc.appArmorProfile.type !== 'Localhost') {
    return 'appArmorProfile';
  }
  return null;
}

/**
 * What baseline forbids in this pod template, as a short name of the field,
 * or null. Also `allowPrivilegeEscalation: true`, which is only "restricted"
 * in the standards but which the agent never needs to grant.
 */
export function riskyPodTemplate(template: PodTemplateRisk | undefined): string | null {
  const spec = template?.spec;
  if (!spec) {
    return null;
  }
  if (spec.hostNetwork || spec.hostPID || spec.hostIPC) {
    return 'hostNetwork/hostPID/hostIPC';
  }
  if ((spec.volumes ?? []).some((v) => v.hostPath !== undefined)) {
    return 'hostPath';
  }
  const pod = contextRisk(spec.securityContext);
  if (pod) {
    return pod;
  }
  if ((spec.securityContext?.sysctls ?? []).some((s) => !(BASELINE_SYSCTLS as readonly string[]).includes(s.name))) {
    return 'sysctls';
  }
  for (const [key, value] of Object.entries(template?.metadata?.annotations ?? {})) {
    if (key.startsWith(APPARMOR_ANNOTATION) && value !== 'runtime/default' && !value.startsWith('localhost/')) {
      return 'AppArmor annotation';
    }
  }
  for (const c of [...(spec.containers ?? []), ...(spec.initContainers ?? []), ...(spec.ephemeralContainers ?? [])]) {
    const sc = c.securityContext;
    if (sc?.privileged) {
      return 'privileged';
    }
    if (sc?.allowPrivilegeEscalation === true) {
      return 'allowPrivilegeEscalation';
    }
    if ((sc?.capabilities?.add ?? []).some((cap) => !(BASELINE_CAPABILITIES as readonly string[]).includes(cap))) {
      return 'capabilities.add';
    }
    if (sc?.procMount !== undefined && sc.procMount !== 'Default') {
      return 'procMount';
    }
    const own = contextRisk(sc);
    if (own) {
      return own;
    }
    if ((c.ports ?? []).some((p) => (p.hostPort ?? 0) !== 0)) {
      return 'hostPort';
    }
    const handlers = [c.livenessProbe, c.readinessProbe, c.startupProbe, c.lifecycle?.postStart, c.lifecycle?.preStop];
    if (handlers.some((h) => (h?.httpGet?.host ?? '') !== '' || (h?.tcpSocket?.host ?? '') !== '')) {
      return 'probe or lifecycle host';
    }
  }
  return null;
}
