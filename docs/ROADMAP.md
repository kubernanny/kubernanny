# Roadmap

Rough order. Nothing here is promised; issues and pull requests move things up.

## Next

- **A QR code in the app** for "pair another device", next to the code and links shown today.
- **Persisted notification state**, so a restart of the agent never re-sends an "opened" (silences and the maintenance window already survive restarts).
- **Native push** through the relay, as an alternative to ntfy for people who want no extra app ([NOTIFICATIONS.md](NOTIFICATIONS.md#native-push-planned)).
- **Per-advisory acceptance** for known vulnerabilities ("we know, it does not apply here"), finer than silencing the component.

## Checks

- Rook Ceph: `CephCluster` health.
- Traefik and ingress-nginx: error rate per router from Prometheus.
- Kyverno / Gatekeeper: policy violations.
- Node clocks (NTP skew from node-exporter), kernel and OS end of life.
- Expiring Kubernetes certificates of the control plane (RKE2/kubeadm).
- Image updates available (compare running tags with the registry), opt-in.
- More components mapped to OSV packages for the vulnerability lookup.

## App

- Widgets (home and lock screen) with the light of each cluster.
- Apple Watch and Wear OS complication.
- Live Activity during an outage.
- More languages: adding one is a catalog per side ([DEVELOPMENT.md](DEVELOPMENT.md#texts-and-languages)).

## Done in 0.3

- English and German, in the app and in the agent's texts.
- Native iOS and Android projects with the `kubernanny://` scheme, released with fastlane.
- One end-to-end protocol for every path, a Noise IK handshake per call ([PROTOCOL.md](PROTOCOL.md)), and the relay for access without a VPN ([RELAY.md](RELAY.md)).
- Gatus and Uptime Kuma, Kubernetes end of support and deprecated APIs, security posture, known vulnerabilities.
- Silencing issues, maintenance windows, incident history, weekly digest, backups overview.
- A demo in the app and at demo.kubernanny.app.

## Not planned

A general cluster browser or YAML editor (kubenav, k9s and Lens do that well), an account or a hosted backend that cluster data passes through, telemetry by default, a paid tier.
