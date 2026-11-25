# Roadmap

Rough order. Nothing here is promised; issues and pull requests move things up.

## Next

- **A QR code in the app** for "pair another device", next to the code and links shown today.
- **Open the right cluster when a push is tapped** (the push carries it; the app does not route the tap yet).

## Checks

- Kernel and OS end of life (needs a reliable source; osImage alone is not).
- Expiring certificates of the control plane beyond the API server (not visible with the agent's access today).
- Expiring client certificates from `apiserver_client_certificate_expiration_seconds`.
- More components mapped to OSV packages for the vulnerability lookup.

## App

- Apple Watch and Wear OS complication.
- Live Activity during an outage.
- More languages: adding one is a catalog per side ([DEVELOPMENT.md](DEVELOPMENT.md#texts-and-languages)).

## Done in 0.3

- English and German, in the app and in the agent's texts.
- Native iOS and Android projects with the `kubernanny://` scheme, released with fastlane.
- One end-to-end protocol for every path, a Noise IK handshake per call ([PROTOCOL.md](PROTOCOL.md)), and the relay for access without a VPN ([RELAY.md](RELAY.md)).
- Gatus and Uptime Kuma, Kubernetes end of support and deprecated APIs, security posture, known vulnerabilities.
- Silencing issues, maintenance windows, incident history, weekly digest, backups overview, home-screen widgets.
- A demo in the app and at demo.kubernanny.app.
- Native push to the app, end-to-end encrypted; notification state that survives restarts.
- Trivy Operator's reports for every image; Rook Ceph, Traefik and ingress-nginx error rates, Kyverno and Gatekeeper, node clocks, available image updates.
- A generated permissions reference, and "does not apply here" for single advisories.

## Not planned

A general cluster browser or YAML editor (kubenav, k9s and Lens do that well), an account or a hosted backend that cluster data passes through, telemetry by default, a paid tier.
