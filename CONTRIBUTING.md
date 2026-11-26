# Contributing

Thanks for helping. The most useful contributions are small: a component Kubernanny does not recognise yet, a check you do by hand every week, a false alarm you hit.

## Before you start

- **New component**: one line in `agent/src/discovery/catalog.ts` and one in `docs/COMPONENTS.md`. No issue needed, just open a pull request.
- **New check or integration**: open an issue first with what you look at by hand and when it should be a warning or critical. [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md#a-new-integration-a-deep-check) shows the shape.
- **New action**: please discuss first. Every action widens what a paired device can do; see [docs/SECURITY.md](docs/SECURITY.md).
- **False positive**: the most valuable bug report. Include what Kubernanny said, what the object looked like (`kubectl get … -o yaml`, secrets removed) and why it is fine.

## Workflow

```sh
cd agent && npm ci && npm test
cd app && npm ci && npm test
```

Both must stay green. CI also lints the chart and validates the manifests.

- Conventional Commits (`feat(agent): recognise Gatus`, `fix(app): …`).
- Pure functions for judgements, with a test each. Integrations only fetch.
- Give the demo cluster the data your check reads (`agent/src/demo/demo-cluster.ts`); the healthy scenario must still raise no issue.
- UI changes: include a screenshot, phone width, dark and light.
- User-facing copy ships in English and German: every text goes into both catalogs (agent: `agent/src/i18n/messages.de.ts` and `messages.en.ts`; app: `app/src/app/i18n/de.ts` and `en.ts`), sentence case, no em dashes. The compiler or the tests fail when a key is missing in one of them ([docs/DEVELOPMENT.md](docs/DEVELOPMENT.md#texts-and-languages)).

## Code of conduct

Be kind and assume good intent. Harassment or personal attacks are not tolerated; maintainers may remove comments and block accounts.
