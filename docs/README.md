# Kubernanny documentation

What Kubernanny is and how to install it: the [README](../README.md). These pages are also published at https://kubernanny.app/docs, built from this folder on every push to main.

## Use it

| | |
|---|---|
| [COMPONENTS.md](COMPONENTS.md) | The components Kubernanny recognises (kept in step with the catalog by a test) |
| [CHECKS.md](CHECKS.md) | Every issue it can raise, with id, severity, threshold and action |
| [SECURITY-CHECKS.md](SECURITY-CHECKS.md) | Posture hints, the vulnerability lookup, Trivy Operator's reports and image updates, and what each sends |
| [NOTIFICATIONS.md](NOTIFICATIONS.md) | When a message is sent, the channels, native push, widgets, the dead man's switch |
| [SCREENSHOTS.md](SCREENSHOTS.md) | One picture per screen |

## Run it

| | |
|---|---|
| [IN-CLUSTER.md](IN-CLUSTER.md) | Everything it runs in your cluster: processes, ports, connections in and out, stored data, how to verify |
| [PERMISSIONS.md](PERMISSIONS.md) | Every permission (generated from the code), why, and which switch removes what |
| [CONFIGURATION.md](CONFIGURATION.md) | Helm values and environment variables |
| [RELAY.md](RELAY.md) | Remote access without a VPN: the public relay, running your own, limits |

## Review it

| | |
|---|---|
| [SECURITY.md](SECURITY.md) | The security model: threats per attacker, revoking devices, rotation, supply chain, reviews |
| [COMMUNICATION.md](COMMUNICATION.md) | Every connection and what protects it, with a diagram |
| [PROTOCOL.md](PROTOCOL.md) | The wire: Noise IK per call, pairing, relay frames, push messages, test vectors |
| [decisions/](decisions/README.md) | Decision records: why Noise, device keys, the internal socket, the relay, languages, push |

## Change it

| | |
|---|---|
| [ARCHITECTURE.md](ARCHITECTURE.md) | How the agent and the app work: run loop, discovery, modules, actions, notifications, widgets |
| [API.md](API.md) | The agent's HTTP API and Prometheus metrics |
| [DEVELOPMENT.md](DEVELOPMENT.md) | Local setup, tests, lint, adding components, integrations and actions, native builds |
| [DESIGN.md](DESIGN.md) | Principles, the nanny's eye, tokens, type, layout, charts, copy |
| [ROADMAP.md](ROADMAP.md) | What comes next, and what will not |

Maintainers: [RELEASING.md](RELEASING.md) (not published on the website).
