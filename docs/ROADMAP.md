# Roadmap

Rough order. Nothing here is promised; issues and pull requests move things up.

## Next

- **A QR code in the app** for "pair another device", next to the code and links shown today.

## Checks

- Kernel and OS end of life (needs a reliable source; osImage alone is not).
- Expiring certificates of the control plane beyond the API server (not visible with the agent's access today).
- Expiring client certificates from `apiserver_client_certificate_expiration_seconds`.
- More components mapped to OSV packages for the vulnerability lookup.

## App

- Apple Watch and Wear OS complication.
- Live Activity during an outage.
- More languages: adding one is a catalog per side ([DEVELOPMENT.md](DEVELOPMENT.md#texts-and-languages)).

## Not planned

A general cluster browser or YAML editor (kubenav, k9s and Lens do that well), an account or a hosted backend that cluster data passes through, telemetry by default, a paid tier.
