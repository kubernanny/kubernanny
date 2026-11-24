# kubernanny Helm chart

```sh
helm install kubernanny oci://ghcr.io/kubernanny/charts/kubernanny -n kubernanny --create-namespace
kubectl -n kubernanny logs deploy/kubernanny     # QR code + one-time pairing code
```

Installs one agent pod (non-root, read-only filesystem), a ServiceAccount with read access plus the four actions' verbs, a Service (80 → API and web UI, 9100 → metrics), and optionally an Ingress and a ServiceMonitor. The agent creates two Secrets itself: `kubernanny-identity` (its key pair, which every device pins) and `kubernanny-devices` (public keys of paired devices). They are not managed by Helm and survive an uninstall; deleting `kubernanny-identity` rotates the agent key and means pairing every device again.

Every value: [docs/CONFIGURATION.md](../../../docs/CONFIGURATION.md). Permissions and threat model: [docs/SECURITY.md](../../../docs/SECURITY.md).

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
