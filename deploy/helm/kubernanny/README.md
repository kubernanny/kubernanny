# kubernanny Helm chart

```sh
helm install kubernanny oci://ghcr.io/kubernanny/charts/kubernanny -n kubernanny --create-namespace
kubectl -n kubernanny logs deploy/kubernanny     # QR code + one-time pairing code
```

Installs one agent pod (non-root, read-only filesystem), a ServiceAccount with read access plus the verbs of the enabled actions (each one switchable, some off until you opt in; the list: [docs/PERMISSIONS.md](../../../docs/PERMISSIONS.md)), a Service (80 → API and web UI, 9100 → metrics), and optionally an Ingress and a ServiceMonitor. The agent creates two Secrets itself: `kubernanny-identity` (its key pair, which every device pins) and `kubernanny-devices` (public keys of paired devices). They are not managed by Helm and survive an uninstall; deleting `kubernanny-identity` rotates the agent key and means pairing every device again.

Upgrades roll without downtime: the new pod gets traffic once its first check run is in memory (`/readyz`), and only the pod holding the Lease `kubernanny` in the release namespace sends notifications, runs actions and holds the relay connection; the old pod hands it over on SIGTERM (details: [ARCHITECTURE.md](../../../docs/ARCHITECTURE.md#deployment)). There is no PodDisruptionBudget on purpose: with one replica it would only block node drains; a drain costs a few seconds of page while the replacement starts.

Every value: [docs/CONFIGURATION.md](../../../docs/CONFIGURATION.md). Threat model: [docs/SECURITY.md](../../../docs/SECURITY.md).

Common setups:

```yaml
# Read-only, no actions
rbac:
  allowActions: false

# On a VPN-only Traefik entrypoint with cert-manager
ingress:
  enabled: true
  className: traefik
  host: kubernanny.example.com
  annotations:
    cert-manager.io/cluster-issuer: letsencrypt-prod

# Notifications
notifications:
  ntfyUrl: https://ntfy.sh/<long-random-topic>
  existingSecret: kubernanny-notify          # WEBHOOK_URL, NTFY_TOKEN
```
