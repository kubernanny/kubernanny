# Contributing

Thanks for helping. The most useful contributions are small: a component Kubernanny does not recognise yet, a check you do by hand every week, a false alarm you hit.

## Before you start

- **New component**: one line in `agent/src/discovery/catalog.ts` and one in `docs/COMPONENTS.md`. No issue needed, just open a pull request.
- **New check or inspector**: open an issue first with what you look at by hand and when it should be a warning or critical. [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md#adding-an-inspector-a-deep-check) shows the shape.
- **New action**: please discuss first. Every action widens what a paired device can do; see [docs/SECURITY.md](docs/SECURITY.md).
- **False positive**: the most valuable bug report. Include what Kubernanny said, what the object looked like (`kubectl get … -o yaml`, secrets removed) and why it is fine.

## Workflow

```sh
cd agent && npm ci && npm test
cd app && npm ci && npm test
```

Both must stay green. CI also lints the chart and validates the manifests.

- Conventional Commits (`feat(agent): recognise Gatus`, `fix(app): …`).
- Pure functions for judgements, with a test each. Inspectors only fetch.
- Give the demo cluster the data your check reads (`agent/src/demo/demo-cluster.ts`); the healthy scenario must still raise no issue.
- UI changes: include a screenshot, phone width, dark and light.
- User-facing copy is German today, sentence case, no em dashes. English is on the roadmap; until then a German text with an English note in the PR is fine.

## Code of conduct

Be kind and assume good intent. Harassment or personal attacks are not tolerated; maintainers may remove comments and block accounts.
