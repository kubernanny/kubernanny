# Recognised components

Kubernanny recognises components by the container images of their Deployments, StatefulSets and DaemonSets (`agent/src/discovery/catalog.ts`), so it does not matter which chart, operator or namespace installed them.

**Deep check** means a dedicated integration reads the component's own state (CRDs, health endpoints, Prometheus). Every other component is checked through its workloads (ready replicas, crashing pods, stuck rollouts) and shows its version, namespace and ingress URL.

This file is checked against the catalog by `agent/src/docs.spec.ts`: a component added to the catalog without a line here fails the tests.

## Storage

| Id | Component | What it is | Deep check |
|---|---|---|---|
| `longhorn` | Longhorn | Repliziertes Block-Storage über alle Nodes. | yes |
| `local-path` | Local Path Provisioner | Volumes direkt auf der Platte eines Nodes. |  |
| `rook-ceph` | Rook Ceph | Ceph-Cluster als Operator. | yes |
| `openebs` | OpenEBS | Container Attached Storage. |  |
| `minio` | MinIO | S3-kompatibler Objektspeicher. |  |
| `nfs-provisioner` | NFS Provisioner | Volumes auf einem NFS-Share. |  |

## GitOps

| Id | Component | What it is | Deep check |
|---|---|---|---|
| `argocd` | Argo CD | Hält den Cluster im Stand des Git-Repos. | yes |
| `argocd-image-updater` | Argo CD Image Updater | Setzt neue Image-Tags in Argo-Apps. |  |
| `flux` | Flux | GitOps-Controller der CNCF. | yes |
| `renovate` | Renovate | Hält Abhängigkeiten aktuell. |  |

## Databases

| Id | Component | What it is | Deep check |
|---|---|---|---|
| `cnpg` | CloudNativePG | PostgreSQL-Operator mit Replikation und Backups. | yes |
| `postgres` | PostgreSQL | Datenbank. |  |
| `mariadb` | MariaDB / MySQL | Datenbank. |  |
| `redis` | Redis / Valkey | In-Memory-Speicher und Cache. |  |
| `mongodb` | MongoDB | Dokumentendatenbank. |  |

## Certificates

| Id | Component | What it is | Deep check |
|---|---|---|---|
| `cert-manager` | cert-manager | Stellt TLS-Zertifikate aus und verlängert sie. | yes |

## Observability

| Id | Component | What it is | Deep check |
|---|---|---|---|
| `prometheus` | Prometheus | Sammelt Metriken und wertet Regeln aus. | yes |
| `alertmanager` | Alertmanager | Verteilt und gruppiert Alerts. | yes |
| `prometheus-operator` | Prometheus Operator | Verwaltet Prometheus und Alertmanager. |  |
| `grafana` | Grafana | Dashboards für Metriken und Logs. | yes |
| `loki` | Loki | Speichert und durchsucht Logs. | yes |
| `promtail` | Promtail | Schickt Container-Logs an Loki. |  |
| `alloy` | Grafana Alloy | Sammelt Metriken, Logs und Traces. |  |
| `tempo` | Tempo | Speichert Traces. |  |
| `kube-state-metrics` | kube-state-metrics | Metriken über Kubernetes-Objekte. |  |
| `node-exporter` | Node Exporter | Metriken der Nodes (CPU, Platte, Netz). |  |
| `blackbox-exporter` | Blackbox Exporter | Prüft Endpunkte von außen. |  |
| `uptime-kuma` | Uptime Kuma | Erreichbarkeit von Diensten. | yes (with `UPTIME_KUMA_STATUS_PAGE`) |
| `gatus` | Gatus | Statusseite und Erreichbarkeitsprüfungen. | yes |
| `metrics-server` | metrics-server | Aktuelle CPU- und RAM-Werte für kubectl top und HPA. | yes |

## Networking

| Id | Component | What it is | Deep check |
|---|---|---|---|
| `traefik` | Traefik | Ingress-Controller und Reverse Proxy. | yes (with Prometheus) |
| `ingress-nginx` | ingress-nginx | Ingress-Controller. | yes (with Prometheus) |
| `coredns` | CoreDNS | DNS im Cluster. |  |
| `cilium` | Cilium | Netzwerk-Plugin (CNI). |  |
| `calico` | Calico / Canal | Netzwerk-Plugin (CNI). |  |
| `flannel` | Flannel | Netzwerk-Plugin (CNI). |  |
| `metallb` | MetalLB | LoadBalancer-IPs im eigenen Netz. |  |
| `kube-vip` | kube-vip | Virtuelle IP für API und Services. |  |
| `external-dns` | ExternalDNS | Pflegt DNS-Einträge aus Ingresses. |  |
| `cloudflared` | Cloudflare Tunnel | Tunnel ins Internet ohne offene Ports. |  |
| `tailscale` | Tailscale | VPN zwischen Geräten. |  |
| `wireguard` | WireGuard | VPN. |  |
| `pihole` | Pi-hole / AdGuard | DNS mit Werbeblocker. |  |

## Security

| Id | Component | What it is | Deep check |
|---|---|---|---|
| `infisical` | Infisical | Secret-Verwaltung. | yes |
| `external-secrets` | External Secrets | Holt Secrets aus externen Tresoren. | yes |
| `sealed-secrets` | Sealed Secrets | Verschlüsselte Secrets im Git. |  |
| `vault` | Vault | Secret-Tresor. |  |
| `kyverno` | Kyverno | Richtlinien für Ressourcen. | yes |
| `trivy` | Trivy Operator | Prüft jedes Image im Cluster auf bekannte Schwachstellen. | yes |
| `gatekeeper` | OPA Gatekeeper | Richtlinien für Ressourcen mit Open Policy Agent. | yes |
| `authentik` | authentik | Single Sign-On. |  |
| `keycloak` | Keycloak | Single Sign-On. |  |
| `crowdsec` | CrowdSec | Erkennt und blockt Angriffe. |  |

## Maintenance

| Id | Component | What it is | Deep check |
|---|---|---|---|
| `kured` | kured | Startet Nodes nach Updates nacheinander neu. | yes |
| `system-upgrade-controller` | System Upgrade Controller | Aktualisiert k3s/RKE2 nach Plänen. | yes |
| `descheduler` | Descheduler | Verteilt Pods neu auf die Nodes. |  |
| `reloader` | Reloader | Startet Pods bei geänderten Secrets neu. |  |
| `keel` | Keel | Aktualisiert Images automatisch. |  |

## Backup

| Id | Component | What it is | Deep check |
|---|---|---|---|
| `velero` | Velero | Backups von Ressourcen und Volumes. | yes |
| `k8up` | K8up | Backups mit restic. |  |
| `volsync` | VolSync | Repliziert und sichert Volumes. |  |

## Platform

| Id | Component | What it is | Deep check |
|---|---|---|---|
| `rancher` | Rancher | Verwaltungsoberfläche für Cluster. |  |
| `portainer` | Portainer | Verwaltungsoberfläche. |  |
| `harbor` | Harbor | Eigene Container-Registry. |  |
| `registry` | Registry | Container-Registry. |  |
| `kubernanny` | Kubernanny | Dieser Agent. |  |

## Self-hosted apps

| Id | Component | What it is | Deep check |
|---|---|---|---|
| `nextcloud` | Nextcloud | Dateien, Kalender, Kontakte. |  |
| `immich` | Immich | Fotos und Videos. |  |
| `jellyfin` | Jellyfin | Mediaserver. |  |
| `plex` | Plex | Mediaserver. |  |
| `home-assistant` | Home Assistant | Hausautomation. |  |
| `vaultwarden` | Vaultwarden | Passwort-Manager. |  |
| `paperless` | Paperless-ngx | Dokumentenarchiv. |  |
| `gitea` | Gitea / Forgejo | Git-Hosting. |  |
| `discourse` | Discourse | Forum. |  |
| `weblate` | Weblate | Übersetzungsplattform. |  |
| `pgadmin` | pgAdmin | Oberfläche für PostgreSQL. |  |
| `n8n` | n8n | Automatisierungen. |  |
| `mealie` | Mealie | Rezepte. |  |

## Adding one

One line in `agent/src/discovery/catalog.ts`:

```ts
{ id: 'harbor', name: 'Harbor', category: 'platform', icon: 'boat-outline', images: img('goharbor/harbor-core'), description: t('component.harbor') },
```

`img('a/b')` matches `…/a/b:tag` and `…/a/b@sha256:…` on any registry. Use an icon from [ionicons](https://ionic.io/ionicons) and register it in `app/src/app/core/icons.ts` (generated, see `docs/DEVELOPMENT.md`). For a deep check, see *A new integration* in the same file.
