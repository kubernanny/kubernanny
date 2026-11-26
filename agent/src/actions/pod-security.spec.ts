import { describe, expect, it } from 'vitest';

import { PodTemplateRisk, riskyPodTemplate } from './pod-security';

const c = (extra: object = {}) => ({ name: 'c', image: 'busybox', ...extra });
const tpl = (spec: object, annotations?: Record<string, string>): PodTemplateRisk =>
  ({ ...(annotations ? { metadata: { annotations } } : {}), spec }) as PodTemplateRisk;
const sc = (securityContext: object) => c({ securityContext });

describe('riskyPodTemplate (Pod Security Standards baseline)', () => {
  it.each([
    ['plain', tpl({ containers: [c()] })],
    [
      'baseline capabilities',
      tpl({ containers: [sc({ capabilities: { add: ['NET_BIND_SERVICE', 'CHOWN'], drop: ['ALL'] } })] }),
    ],
    [
      'an allowed SELinux type',
      tpl({
        securityContext: { seLinuxOptions: { type: 'container_t', level: 's0:c1,c2' } },
        containers: [sc({ seLinuxOptions: { type: 'container_init_t' } })],
      }),
    ],
    [
      'RuntimeDefault seccomp and AppArmor',
      tpl({
        securityContext: { seccompProfile: { type: 'RuntimeDefault' }, appArmorProfile: { type: 'Localhost' } },
        containers: [sc({ appArmorProfile: { type: 'RuntimeDefault' } })],
      }),
    ],
    [
      'AppArmor annotations runtime/default and localhost/*',
      tpl(
        { containers: [c()] },
        {
          'container.apparmor.security.beta.kubernetes.io/c': 'runtime/default',
          'container.apparmor.security.beta.kubernetes.io/d': 'localhost/mine',
        },
      ),
    ],
    [
      'safe sysctls',
      tpl({
        securityContext: { sysctls: [{ name: 'net.ipv4.ip_local_port_range' }, { name: 'kernel.shm_rmid_forced' }] },
        containers: [c()],
      }),
    ],
    [
      'a container port without hostPort, hostPort 0',
      tpl({ containers: [c({ ports: [{ containerPort: 80 }, { containerPort: 81, hostPort: 0 }] })] }),
    ],
    [
      'procMount Default, hostProcess false',
      tpl({ securityContext: { windowsOptions: { hostProcess: false } }, containers: [sc({ procMount: 'Default' })] }),
    ],
    [
      'probes without host',
      tpl({
        containers: [
          c({
            livenessProbe: { httpGet: { path: '/', port: 80 } },
            lifecycle: { preStop: { tcpSocket: { port: 80, host: '' } } },
          }),
        ],
      }),
    ],
  ])('allows %s', (_name, template) => {
    expect(riskyPodTemplate(template)).toBeNull();
  });

  it.each([
    ['hostNetwork', tpl({ hostNetwork: true, containers: [c()] }), 'hostNetwork/hostPID/hostIPC'],
    ['hostPID', tpl({ hostPID: true, containers: [c()] }), 'hostNetwork/hostPID/hostIPC'],
    ['a hostPath volume', tpl({ volumes: [{ hostPath: { path: '/' } }], containers: [c()] }), 'hostPath'],
    ['privileged', tpl({ containers: [sc({ privileged: true })] }), 'privileged'],
    ['privileged init container', tpl({ containers: [c()], initContainers: [sc({ privileged: true })] }), 'privileged'],
    [
      'privileged ephemeral container',
      tpl({ containers: [c()], ephemeralContainers: [sc({ privileged: true })] }),
      'privileged',
    ],
    [
      'allowPrivilegeEscalation',
      tpl({ containers: [sc({ allowPrivilegeEscalation: true })] }),
      'allowPrivilegeEscalation',
    ],
    ['SYS_ADMIN', tpl({ containers: [sc({ capabilities: { add: ['CHOWN', 'SYS_ADMIN'] } })] }), 'capabilities.add'],
    [
      'NET_ADMIN on an init container',
      tpl({ containers: [c()], initContainers: [sc({ capabilities: { add: ['NET_ADMIN'] } })] }),
      'capabilities.add',
    ],
    ['a hostPort', tpl({ containers: [c({ ports: [{ containerPort: 80, hostPort: 8080 }] })] }), 'hostPort'],
    [
      'SELinux spc_t on the pod',
      tpl({ securityContext: { seLinuxOptions: { type: 'spc_t' } }, containers: [c()] }),
      'seLinuxOptions',
    ],
    [
      'SELinux user on a container',
      tpl({ containers: [sc({ seLinuxOptions: { user: 'system_u' } })] }),
      'seLinuxOptions',
    ],
    [
      'SELinux role',
      tpl({ securityContext: { seLinuxOptions: { role: 'sysadm_r' } }, containers: [c()] }),
      'seLinuxOptions',
    ],
    [
      'hostProcess on the pod',
      tpl({ securityContext: { windowsOptions: { hostProcess: true } }, containers: [c()] }),
      'windowsOptions.hostProcess',
    ],
    [
      'hostProcess on a container',
      tpl({ containers: [sc({ windowsOptions: { hostProcess: true } })] }),
      'windowsOptions.hostProcess',
    ],
    ['procMount Unmasked', tpl({ containers: [sc({ procMount: 'Unmasked' })] }), 'procMount'],
    [
      'seccomp Unconfined on the pod',
      tpl({ securityContext: { seccompProfile: { type: 'Unconfined' } }, containers: [c()] }),
      'seccompProfile Unconfined',
    ],
    [
      'seccomp Unconfined on a container',
      tpl({ containers: [sc({ seccompProfile: { type: 'Unconfined' } })] }),
      'seccompProfile Unconfined',
    ],
    [
      'AppArmor Unconfined field',
      tpl({ containers: [sc({ appArmorProfile: { type: 'Unconfined' } })] }),
      'appArmorProfile',
    ],
    [
      'AppArmor unconfined annotation',
      tpl({ containers: [c()] }, { 'container.apparmor.security.beta.kubernetes.io/c': 'unconfined' }),
      'AppArmor annotation',
    ],
    [
      'an unsafe sysctl',
      tpl({ securityContext: { sysctls: [{ name: 'kernel.msgmax' }] }, containers: [c()] }),
      'sysctls',
    ],
    [
      'a probe to another host',
      tpl({ containers: [c({ readinessProbe: { httpGet: { host: '10.0.0.1', port: 80 } } })] }),
      'probe or lifecycle host',
    ],
    [
      'a lifecycle hook to another host',
      tpl({ containers: [c({ lifecycle: { postStart: { tcpSocket: { host: 'db', port: 5432 } } } })] }),
      'probe or lifecycle host',
    ],
  ])('refuses %s', (_name, template, what) => {
    expect(riskyPodTemplate(template)).toBe(what);
  });
});
