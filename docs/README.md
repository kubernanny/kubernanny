# Kubernanny documentation

Start with the [README](../README.md) for what Kubernanny is and how to install it.

Also published at https://kubernanny.app/docs, built from this folder by `website/` on every push to main.

| Document | For |
|---|---|
| [IN-CLUSTER.md](IN-CLUSTER.md) | Everything Kubernanny runs in your cluster: processes, ports, permissions, outbound connections, stored data, switches, how to verify |
| [RELAY.md](RELAY.md) | The optional relay: when you need it, what it can and cannot see, limits, running your own (Node or Cloudflare Worker) |
| [ARCHITECTURE.md](ARCHITECTURE.md) | How the agent and the app work: the run loop, discovery, modules, actions, notifications, pairing, deployment, design decisions |
| [CHECKS.md](CHECKS.md) | Every issue Kubernanny can raise, with id, severity, threshold and action |
| [SECURITY-CHECKS.md](SECURITY-CHECKS.md) | The security posture hints and the vulnerability lookup against OSV.dev |
| [COMPONENTS.md](COMPONENTS.md) | The components Kubernanny recognises (kept in step with the catalog by a test) |
| [CONFIGURATION.md](CONFIGURATION.md) | Helm values, environment variables, what the app stores |
| [COMMUNICATION.md](COMMUNICATION.md) | Every connection, what protects it, what an attacker could do, residual risks; with a diagram |
| [PROTOCOL.md](PROTOCOL.md) | The end-to-end protocol: Noise IK per call, pairing, what the agent checks, limits, test vectors |
| [decisions/](decisions/README.md) | Decision records: Noise IK, device keys, the internal socket, direct and relay |
| [SECURITY.md](SECURITY.md) | RBAC, threat model, revoking devices, rotation |
| [NOTIFICATIONS.md](NOTIFICATIONS.md) | ntfy, Discord, Slack, Gotify, JSON; timing; alerting on Kubernanny |
| [API.md](API.md) | The agent's HTTP API and Prometheus metrics |
| [DEVELOPMENT.md](DEVELOPMENT.md) | Local setup, demo mode, tests, adding components, integrations and actions, native builds, releases |
| [RELEASING.md](RELEASING.md) | Native iOS/Android projects, one-time store setup, release commands and versioning |
| [DESIGN.md](DESIGN.md) | Principles, the heartbeat, tokens, type, layout, charts, copy |
| [SCREENSHOTS.md](SCREENSHOTS.md) | Every screen, phone, tablet, desktop, dark and light |
| [ROADMAP.md](ROADMAP.md) | What comes next, and what will not |
