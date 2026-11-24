import { Text, t } from '../i18n/text';

export type Category =
  | 'storage'
  | 'gitops'
  | 'database'
  | 'certificates'
  | 'observability'
  | 'networking'
  | 'security'
  | 'maintenance'
  | 'backup'
  | 'platform'
  | 'apps';

export interface CatalogEntry {
  id: string;
  name: string;
  category: Category;
  /** Set for components defined in CUSTOM_COMPONENTS. */
  custom?: boolean;
  /** An ionicon name; the app shows it next to the component. */
  icon: string;
  /** Matched against every container image of every workload. */
  images: RegExp[];
  /** One sentence, what it is for, shown under the name. */
  description: Text;
  /**
   * The package OSV.dev files this component's advisories under, for the
   * `vulnerabilities` module. Only set where real queries showed that OSV
   * covers it with release versions that match the image tags (see
   * docs/SECURITY-CHECKS.md for the ones left out and why).
   */
  osv?: OsvPackage;
}

/**
 * - `goMajor`: a Go module from v2 on carries the major version in its path
 *   (`…/argo-cd/v3`); `minMajor` drops majors published under another path.
 * - `image`: only when the version was read from a matching image (Gitea, not
 *   Forgejo, whose versions mean something else).
 * - `calver`: the project numbers its releases by date (2024.10.15), so such a
 *   tag is a release; for everyone else a date-like tag is a build, not one.
 */
export interface OsvPackage {
  ecosystem: string;
  name: string;
  goMajor?: boolean;
  minMajor?: number;
  image?: RegExp;
  calver?: boolean;
}

const img = (...parts: string[]) => parts.map((p) => new RegExp(`(^|/)${p}(:|@|$)`));

/**
 * Components recognised by their container images, so detection works
 * whatever chart, operator or namespace installed them. Order matters only
 * when two entries match the same workload: the first wins.
 */
export const CATALOG: CatalogEntry[] = [
  // storage
  { id: 'longhorn', name: 'Longhorn', category: 'storage', icon: 'server-outline', images: img('longhorn-manager'), description: t('component.longhorn') },
  { id: 'local-path', name: 'Local Path Provisioner', category: 'storage', icon: 'folder-outline', images: img('local-path-provisioner'), description: t('component.local-path') },
  { id: 'rook-ceph', name: 'Rook Ceph', category: 'storage', icon: 'server-outline', images: img('rook/ceph'), description: t('component.rook-ceph') },
  { id: 'openebs', name: 'OpenEBS', category: 'storage', icon: 'server-outline', images: [/openebs\//], description: t('component.openebs') },
  { id: 'minio', name: 'MinIO', category: 'storage', icon: 'cube-outline', images: img('minio/minio', 'bitnami/minio'), description: t('component.minio') },
  { id: 'nfs-provisioner', name: 'NFS Provisioner', category: 'storage', icon: 'folder-outline', images: [/nfs-subdir-external-provisioner/, /csi-driver-nfs/, /nfsplugin/], description: t('component.nfs-provisioner') },

  // gitops
  { id: 'argocd', name: 'Argo CD', category: 'gitops', icon: 'git-branch-outline', images: img('argoproj/argocd', 'argocd'), description: t('component.argocd'), osv: { ecosystem: 'Go', name: 'github.com/argoproj/argo-cd', goMajor: true } },
  { id: 'argocd-image-updater', name: 'Argo CD Image Updater', category: 'gitops', icon: 'git-pull-request-outline', images: img('argoproj-labs/argocd-image-updater', 'argoprojlabs/argocd-image-updater'), description: t('component.argocd-image-updater') },
  { id: 'flux', name: 'Flux', category: 'gitops', icon: 'git-branch-outline', images: img('fluxcd/source-controller', 'fluxcd/kustomize-controller'), description: t('component.flux'), osv: { ecosystem: 'Go', name: 'github.com/fluxcd/source-controller', image: /fluxcd\/source-controller(:|@|$)/ } },
  { id: 'renovate', name: 'Renovate', category: 'gitops', icon: 'git-pull-request-outline', images: img('renovate/renovate'), description: t('component.renovate') },

  // databases
  { id: 'cnpg', name: 'CloudNativePG', category: 'database', icon: 'server-outline', images: img('cloudnative-pg', 'cloudnative-pg/cloudnative-pg'), description: t('component.cnpg'), osv: { ecosystem: 'Go', name: 'github.com/cloudnative-pg/cloudnative-pg' } },
  { id: 'postgres', name: 'PostgreSQL', category: 'database', icon: 'server-outline', images: [/(^|\/)postgres(ql)?(:|@|$)/, /bitnami\/postgresql/, /cloudnative-pg\/postgresql/, /cloudnative-pg\/postgis/], description: t('component.postgres') },
  { id: 'mariadb', name: 'MariaDB / MySQL', category: 'database', icon: 'server-outline', images: img('mariadb', 'mysql', 'bitnami/mariadb', 'bitnami/mysql'), description: t('component.mariadb') },
  { id: 'redis', name: 'Redis / Valkey', category: 'database', icon: 'flash-outline', images: img('redis', 'valkey', 'valkey/valkey', 'bitnami/redis', 'bitnami/valkey'), description: t('component.redis') },
  { id: 'mongodb', name: 'MongoDB', category: 'database', icon: 'server-outline', images: img('mongo', 'bitnami/mongodb'), description: t('component.mongodb') },

  // certificates & security
  { id: 'cert-manager', name: 'cert-manager', category: 'certificates', icon: 'ribbon-outline', images: img('jetstack/cert-manager-controller', 'cert-manager-controller'), description: t('component.cert-manager'), osv: { ecosystem: 'Go', name: 'github.com/cert-manager/cert-manager' } },
  { id: 'infisical', name: 'Infisical', category: 'security', icon: 'key-outline', images: img('infisical/infisical', 'infisical/kubernetes-operator'), description: t('component.infisical') },
  { id: 'external-secrets', name: 'External Secrets', category: 'security', icon: 'key-outline', images: img('external-secrets/external-secrets'), description: t('component.external-secrets'), osv: { ecosystem: 'Go', name: 'github.com/external-secrets/external-secrets' } },
  { id: 'sealed-secrets', name: 'Sealed Secrets', category: 'security', icon: 'lock-closed-outline', images: img('bitnami-labs/sealed-secrets-controller', 'bitnami/sealed-secrets-controller', 'sealed-secrets-controller'), description: t('component.sealed-secrets') },
  { id: 'vault', name: 'Vault', category: 'security', icon: 'lock-closed-outline', images: img('hashicorp/vault', 'vault'), description: t('component.vault') },
  { id: 'kyverno', name: 'Kyverno', category: 'security', icon: 'shield-checkmark-outline', images: img('kyverno/kyverno'), description: t('component.kyverno'), osv: { ecosystem: 'Go', name: 'github.com/kyverno/kyverno' } },
  { id: 'authentik', name: 'authentik', category: 'security', icon: 'finger-print-outline', images: img('goauthentik/server', 'authentik/server'), description: t('component.authentik') },
  { id: 'keycloak', name: 'Keycloak', category: 'security', icon: 'finger-print-outline', images: img('keycloak/keycloak', 'bitnami/keycloak'), description: t('component.keycloak') },
  { id: 'crowdsec', name: 'CrowdSec', category: 'security', icon: 'shield-outline', images: img('crowdsecurity/crowdsec'), description: t('component.crowdsec') },

  // observability
  { id: 'prometheus', name: 'Prometheus', category: 'observability', icon: 'pulse-outline', images: img('prometheus/prometheus'), description: t('component.prometheus') },
  { id: 'alertmanager', name: 'Alertmanager', category: 'observability', icon: 'notifications-outline', images: img('prometheus/alertmanager'), description: t('component.alertmanager') },
  { id: 'prometheus-operator', name: 'Prometheus Operator', category: 'observability', icon: 'construct-outline', images: img('prometheus-operator/prometheus-operator'), description: t('component.prometheus-operator') },
  { id: 'grafana', name: 'Grafana', category: 'observability', icon: 'stats-chart-outline', images: img('grafana/grafana', 'grafana/grafana-oss', 'grafana/grafana-enterprise', 'bitnami/grafana'), description: t('component.grafana') },
  { id: 'loki', name: 'Loki', category: 'observability', icon: 'document-text-outline', images: img('grafana/loki'), description: t('component.loki') },
  { id: 'promtail', name: 'Promtail', category: 'observability', icon: 'document-text-outline', images: img('grafana/promtail'), description: t('component.promtail') },
  { id: 'alloy', name: 'Grafana Alloy', category: 'observability', icon: 'git-merge-outline', images: img('grafana/alloy'), description: t('component.alloy') },
  { id: 'tempo', name: 'Tempo', category: 'observability', icon: 'git-network-outline', images: img('grafana/tempo'), description: t('component.tempo') },
  { id: 'kube-state-metrics', name: 'kube-state-metrics', category: 'observability', icon: 'list-outline', images: img('kube-state-metrics/kube-state-metrics', 'kube-state-metrics'), description: t('component.kube-state-metrics') },
  { id: 'node-exporter', name: 'Node Exporter', category: 'observability', icon: 'hardware-chip-outline', images: img('prometheus/node-exporter'), description: t('component.node-exporter') },
  { id: 'blackbox-exporter', name: 'Blackbox Exporter', category: 'observability', icon: 'globe-outline', images: img('prometheus/blackbox-exporter'), description: t('component.blackbox-exporter') },
  { id: 'uptime-kuma', name: 'Uptime Kuma', category: 'observability', icon: 'pulse-outline', images: img('louislam/uptime-kuma'), description: t('component.uptime-kuma') },
  { id: 'gatus', name: 'Gatus', category: 'observability', icon: 'pulse-outline', images: img('twinproduction/gatus'), description: t('component.gatus') },
  { id: 'metrics-server', name: 'metrics-server', category: 'observability', icon: 'speedometer-outline', images: img('metrics-server/metrics-server', 'rancher/hardened-k8s-metrics-server', 'rancher/mirrored-metrics-server'), description: t('component.metrics-server') },

  // networking
  { id: 'traefik', name: 'Traefik', category: 'networking', icon: 'swap-horizontal-outline', images: img('traefik', 'rancher/mirrored-library-traefik', 'rancher/hardened-traefik'), description: t('component.traefik'), osv: { ecosystem: 'Go', name: 'github.com/traefik/traefik', goMajor: true, minMajor: 2 } },
  { id: 'ingress-nginx', name: 'ingress-nginx', category: 'networking', icon: 'swap-horizontal-outline', images: img('ingress-nginx/controller', 'rancher/nginx-ingress-controller', 'rancher/hardened-ingress-nginx'), description: t('component.ingress-nginx') },
  { id: 'coredns', name: 'CoreDNS', category: 'networking', icon: 'at-outline', images: img('coredns/coredns', 'coredns', 'rancher/hardened-coredns', 'rancher/mirrored-coredns-coredns'), description: t('component.coredns') },
  { id: 'cilium', name: 'Cilium', category: 'networking', icon: 'git-network-outline', images: img('cilium/cilium'), description: t('component.cilium'), osv: { ecosystem: 'Go', name: 'github.com/cilium/cilium' } },
  { id: 'calico', name: 'Calico / Canal', category: 'networking', icon: 'git-network-outline', images: img('calico/node', 'rancher/hardened-calico', 'rancher/mirrored-calico-node'), description: t('component.calico') },
  { id: 'flannel', name: 'Flannel', category: 'networking', icon: 'git-network-outline', images: img('flannel/flannel', 'rancher/hardened-flannel', 'flannel-io/flannel'), description: t('component.flannel') },
  { id: 'metallb', name: 'MetalLB', category: 'networking', icon: 'radio-outline', images: img('metallb/controller'), description: t('component.metallb') },
  { id: 'kube-vip', name: 'kube-vip', category: 'networking', icon: 'radio-outline', images: img('kube-vip/kube-vip', 'plndr/kube-vip'), description: t('component.kube-vip') },
  { id: 'external-dns', name: 'ExternalDNS', category: 'networking', icon: 'at-outline', images: img('external-dns/external-dns', 'bitnami/external-dns'), description: t('component.external-dns') },
  { id: 'cloudflared', name: 'Cloudflare Tunnel', category: 'networking', icon: 'cloud-outline', images: img('cloudflare/cloudflared'), description: t('component.cloudflared') },
  { id: 'tailscale', name: 'Tailscale', category: 'networking', icon: 'git-network-outline', images: img('tailscale/tailscale', 'tailscale/k8s-operator'), description: t('component.tailscale') },
  { id: 'wireguard', name: 'WireGuard', category: 'networking', icon: 'git-network-outline', images: [/wireguard/, /wg-easy/], description: t('component.wireguard') },
  { id: 'pihole', name: 'Pi-hole / AdGuard', category: 'networking', icon: 'ban-outline', images: img('pihole/pihole', 'adguard/adguardhome'), description: t('component.pihole') },

  // maintenance
  { id: 'kured', name: 'kured', category: 'maintenance', icon: 'refresh-circle-outline', images: img('kubereboot/kured', 'weaveworks/kured'), description: t('component.kured') },
  { id: 'system-upgrade-controller', name: 'System Upgrade Controller', category: 'maintenance', icon: 'arrow-up-circle-outline', images: img('rancher/system-upgrade-controller'), description: t('component.system-upgrade-controller') },
  { id: 'descheduler', name: 'Descheduler', category: 'maintenance', icon: 'shuffle-outline', images: img('descheduler/descheduler'), description: t('component.descheduler') },
  { id: 'reloader', name: 'Reloader', category: 'maintenance', icon: 'reload-outline', images: img('stakater/reloader'), description: t('component.reloader') },
  { id: 'keel', name: 'Keel', category: 'maintenance', icon: 'arrow-up-circle-outline', images: img('keelhq/keel'), description: t('component.keel') },

  // backup
  { id: 'velero', name: 'Velero', category: 'backup', icon: 'archive-outline', images: img('velero/velero'), description: t('component.velero'), osv: { ecosystem: 'Go', name: 'github.com/vmware-tanzu/velero' } },
  { id: 'k8up', name: 'K8up', category: 'backup', icon: 'archive-outline', images: img('k8up-io/k8up'), description: t('component.k8up') },
  { id: 'volsync', name: 'VolSync', category: 'backup', icon: 'archive-outline', images: img('backube/volsync'), description: t('component.volsync') },

  // platform
  { id: 'rancher', name: 'Rancher', category: 'platform', icon: 'apps-outline', images: img('rancher/rancher'), description: t('component.rancher') },
  { id: 'portainer', name: 'Portainer', category: 'platform', icon: 'apps-outline', images: img('portainer/portainer-ce', 'portainer/portainer-ee'), description: t('component.portainer') },
  { id: 'harbor', name: 'Harbor', category: 'platform', icon: 'boat-outline', images: img('goharbor/harbor-core'), description: t('component.harbor') },
  { id: 'registry', name: 'Registry', category: 'platform', icon: 'boat-outline', images: img('registry'), description: t('component.registry') },
  { id: 'kubernanny', name: 'Kubernanny', category: 'platform', icon: 'heart-outline', images: img('kubernanny/agent', 'kubernanny-agent'), description: t('component.kubernanny') },

  // apps people self-host
  { id: 'nextcloud', name: 'Nextcloud', category: 'apps', icon: 'cloud-outline', images: img('nextcloud', 'nextcloud/server'), description: t('component.nextcloud') },
  { id: 'immich', name: 'Immich', category: 'apps', icon: 'images-outline', images: img('immich-app/immich-server'), description: t('component.immich') },
  { id: 'jellyfin', name: 'Jellyfin', category: 'apps', icon: 'film-outline', images: img('jellyfin/jellyfin'), description: t('component.jellyfin') },
  { id: 'plex', name: 'Plex', category: 'apps', icon: 'film-outline', images: img('plexinc/pms-docker'), description: t('component.plex') },
  { id: 'home-assistant', name: 'Home Assistant', category: 'apps', icon: 'home-outline', images: img('home-assistant/home-assistant', 'homeassistant/home-assistant'), description: t('component.home-assistant') },
  { id: 'vaultwarden', name: 'Vaultwarden', category: 'apps', icon: 'key-outline', images: img('vaultwarden/server'), description: t('component.vaultwarden'), osv: { ecosystem: 'crates.io', name: 'vaultwarden' } },
  { id: 'paperless', name: 'Paperless-ngx', category: 'apps', icon: 'document-outline', images: img('paperless-ngx/paperless-ngx'), description: t('component.paperless') },
  { id: 'gitea', name: 'Gitea / Forgejo', category: 'apps', icon: 'git-commit-outline', images: img('gitea/gitea', 'forgejo/forgejo', 'codeberg.org/forgejo/forgejo'), description: t('component.gitea'), osv: { ecosystem: 'Go', name: 'code.gitea.io/gitea', image: /(^|\/)gitea\/gitea(:|@|$)/ } },
  { id: 'discourse', name: 'Discourse', category: 'apps', icon: 'chatbubbles-outline', images: img('discourse/discourse', 'bitnami/discourse'), description: t('component.discourse') },
  { id: 'weblate', name: 'Weblate', category: 'apps', icon: 'language-outline', images: img('weblate/weblate'), description: t('component.weblate'), osv: { ecosystem: 'PyPI', name: 'weblate' } },
  { id: 'pgadmin', name: 'pgAdmin', category: 'apps', icon: 'server-outline', images: img('dpage/pgadmin4'), description: t('component.pgadmin') },
  { id: 'n8n', name: 'n8n', category: 'apps', icon: 'git-merge-outline', images: img('n8nio/n8n'), description: t('component.n8n'), osv: { ecosystem: 'npm', name: 'n8n' } },
  { id: 'mealie', name: 'Mealie', category: 'apps', icon: 'restaurant-outline', images: img('hay-kot/mealie', 'mealie-recipes/mealie'), description: t('component.mealie') },
];

export const CATEGORY_LABEL: Record<Category, string> = {
  storage: 'Speicher',
  gitops: 'GitOps',
  database: 'Datenbanken',
  certificates: 'Zertifikate',
  observability: 'Monitoring',
  networking: 'Netzwerk',
  security: 'Sicherheit',
  maintenance: 'Wartung',
  backup: 'Backups',
  platform: 'Plattform',
  apps: 'Apps',
};
