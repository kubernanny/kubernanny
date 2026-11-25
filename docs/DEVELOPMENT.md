# Development

## Requirements

Node 24 (22 works), npm. For a real cluster: `kubectl`. For native builds: Xcode (iOS) and Android Studio (Android). No cluster needed for anything else: the agent has a demo mode.

## Run everything locally

```sh
# The shared protocol package first: agent and app both link it (file:../protocol)
cd protocol
npm ci && npm run build && npm test   # includes the libsodium cross-test and the test vectors

# Agent against the built-in demo cluster, API on :8080
cd ../agent
npm ci
npm run start:demo                     # DEMO=broken; also try DEMO=warning or DEMO=healthy

# App with live reload on :4200
cd ../app
npm ci
npm start
# open the "In the browser" link from the agent's output (LANGUAGE=de: "Im Browser"), with :8080 replaced by :4200 and &url=http://localhost:8080 added
# (a demo agent takes any pairing code; the key in the link is its real one)
```

Against a real cluster instead of the demo:

```sh
kubectl proxy                           # http://127.0.0.1:8001, your kubeconfig's permissions
cd agent
K8S_API_URL=http://127.0.0.1:8001 POD_NAMESPACE=kubernanny npm run start:dev   # creates kubernanny-identity in that namespace, prints a pairing link
```

Outside a pod the agent reaches Prometheus and friends through the API server's service proxy, which `kubectl proxy` allows. In a pod it uses cluster DNS.

The web UI the agent serves: build the app (`cd app && npx ng build`) and start the agent with `WEB_ROOT=../app/dist/app/browser`.

## Tests

```sh
cd agent && npm test        # Vitest: checks, modules, notifier, pairing, RBAC coverage, HTTP API against the demo, scenarios
cd app && npm test          # Vitest via Angular's unit-test builder: view models, formatting, charts, pairing links, icons
cd relay && npm test        # Vitest: frames, limits, AgentLink, and a real demo agent behind a real relay (needs agent/ installed)
cd protocol && npm test     # Vitest: Noise IK against the test vectors and libsodium, envelopes, relay frames
cd website && npm test      # Vitest: markdown rendering, links between docs, the sidebar
cd app && npm run test:scripts   # node:test for the release and asset scripts
cd e2e && npm test          # Playwright: the web demo in both languages, and the app against a running demo agent
```

The e2e suite builds nothing itself: it serves `app/dist` and starts `agent/dist`, so run `npm run build` in both first, and `npm run build:demo` in `app/` for the demo host tests (`cd e2e && npm run build` does all of it, as CI does).

What the tests guard beyond the logic itself:

| Test | Keeps in step |
|---|---|
| `agent/src/rbac.spec.ts` | `deploy/install.yaml` grants every resource the agent reads, and never `services/proxy` |
| `agent/src/docs.spec.ts` | `docs/COMPONENTS.md` lists every catalog entry |
| `agent/src/demo/scenarios.spec.ts` | the healthy demo raises no issue at all (no false positives), warning is yellow, broken is red |
| `app/src/app/icons.spec.ts` | every icon the catalog names is registered |
| `app/src/app/i18n/i18n.spec.ts` | the app's German and English dictionaries have the same keys and parameters |
| CI step "RBAC follows the switches" | a module or action switched off in Helm loses its permissions |

## The demo in the app

The app's demo (first screen, `/#/demo`, and demo.kubernanny.app) does not run an agent: `app/src/app/core/demo/demo-agent.ts` answers from recordings in `app/public/demo/<scenario>.<lang>.json` and shifts their times to now, so the demo never looks stale. The recordings are made from the agent's demo cluster:

```sh
cd agent && npm run demo:export   # writes app/public/demo/{broken,warning,healthy}.{en,de}.json
```

Run it after changing a check, a text or the demo cluster, and commit the result.

demo.kubernanny.app serves its own build, not the one in the agent's image: `cd app && npm run build:demo` (`ng build --configuration production,demo`, output `app/dist/demo/browser`). It swaps `src/environments/build-flags.ts` for `build-flags.demo.ts` (`DEMO_HOST = true`): the app starts with the demo clusters, `/pair` and `/cluster/new` lead home, the add buttons are gone and `AgentClient` refuses every call that is not the built-in demo. Its response headers (a CSP that lets it connect only to its own origin) are in `app/src/demo-host/_headers`, which only this configuration copies into the output; a host that does not read `_headers` files (Cloudflare Pages and Netlify do) must set them itself. The Website workflow deploys it to the Cloudflare Pages project `kubernanny-demo` on every push to `main` that touches the app; CI builds the configuration, and the e2e tests serve it on port 4330. The flag is decided at build time on purpose: an agent someone serves at `demo.example.com` is an ordinary agent.

Screenshots: `docs/SCREENSHOTS.md` explains how they are made.

## Project layout

```
agent/            NestJS agent (see ARCHITECTURE.md for the module map)
app/              Angular + Ionic + Capacitor app; its web build ships in the agent image
relay/            the relay (NestJS + ws), relay/cloudflare/ the same as a Cloudflare Worker (docs/RELAY.md)
deploy/
  helm/kubernanny/   Helm chart
  install.yaml        plain manifests, same defaults
  relay/              a self-hosted relay: Deployment, Service, Ingress, NetworkPolicy
docs/             this documentation, screenshots
Dockerfile        one image: agent + web UI
.github/          CI, issue and PR templates
```

## Adding a component

1. One line in `agent/src/discovery/catalog.ts`. `img('owner/name')` matches that image on any registry, with any tag or digest. Put specific entries before broad ones; the first match wins. Its description is `t('component.<id>')`: add the sentence to `agent/src/i18n/components.de.ts` and `components.en.ts` (the compiler tells you if one is missing).
2. A line in `docs/COMPONENTS.md` (the test tells you).
3. If the icon is new: `cd app && npm run icons`.
4. Optional: `osv: { ecosystem, name }` when OSV.dev files the component's advisories under release versions that match its image tags, so the `vulnerabilities` module can look it up. Check with real queries first; [SECURITY-CHECKS.md](SECURITY-CHECKS.md#mapped-components) lists what was checked and why some were left out.

That alone gives the component a row in the Dienste tab, its version, pods, ingress URL and workload health.

## A new integration (a deep check)

Every tool Kubernanny looks into (Argo CD, Longhorn, CNPG, …) is one subclass of `Integration` (`agent/src/modules/module.ts`) in its own file under `agent/src/modules/integrations/`. The base class does the bookkeeping, so a subclass only says what it reads and what it concludes:

```ts
// agent/src/modules/integrations/harbor.ts
export class HarborIntegration extends Integration {
  readonly id = 'harbor';                                    // the catalog id; name, icon and description come from there
  readonly reads = [{ group: 'goharbor.io', resource: 'harborclusters' }];
  override readonly actions = [] as const;                   // action types its issues may offer (none here)

  protected async inspect(ctx: ModuleContext): Promise<ModuleResult> {
    const clusters = (await ctx.kube.list<HarborCluster>('/apis/goharbor.io/v1beta2/harborclusters')) ?? [];
    const issues = evaluateHarbor(clusters);                 // pure function in checks/, unit-tested
    return { issues, stats: [{ label: t('harbor.stat.registries'), value: String(clusters.length) }], summary: issues.length ? issues[0].title : t('ready.summary.ok') };
  }
}
```

Then:

1. Add `new HarborIntegration()` to `INTEGRATIONS` in `modules/integrations/index.ts`.
2. `cd agent && npm run rbac`: writes the chart's `files/rbac.json`, from which the ClusterRole grants exactly the declared `reads` (and nothing once someone sets `checks.disabled: [harbor]`). Add the same rule to `deploy/install.yaml`; the RBAC test tells you if anything is missing.
3. Give the demo cluster the data (`agent/src/demo/demo-cluster.ts`) so tests and screenshots cover it.

What you get for free: a switch in the app ("What is checked"), the Helm value to switch it off for good, actions filtered to the declared and enabled types, error handling (a throwing integration shows "Check failed", the run goes on), and the module sheet in the app.

**Operators with a Ready condition** (Flux, External Secrets, Infisical) need no code at all: extend `ReadyConditionIntegration` and name the kinds, see `integrations/flux.ts`.

**In-cluster HTTP** (a component's own API, Prometheus): set `override readonly untrusted = true` and use `this.http(ctx, det, ports)` or `ctx.prom`. Anything that can run a pod could answer in place of those services, so the base class strips every action from an untrusted integration's issues, and trusted integrations do not even get the Prometheus client (`this.http()` throws for them).

Rules of thumb:

- **Pure first.** Put the judgement into a function of plain objects (`evaluateHarbor(clusters)`) and test that. The integration only fetches.
- **Stable ids.** Never put a timestamp or a count into an issue id.
- **Every text in both languages.** `title`, `cause`, `summary` and stat labels are `Text` values from the catalogs ([Texts and languages](#texts-and-languages)).
- **Say why, then what to do.** `title` names what is broken, `cause` explains it in one or two sentences a tired person understands at 4 a.m.
- **Severity**: critical only when something is down or data is at risk now; `info` for hints that never colour the light.
- A list of a CRD that is not installed returns `null`; treat that as "not installed", not as an error.

Core checks of Kubernetes itself work the same way: subclasses of `CoreCheck`, one file each in `modules/core/` (plus `kubernetes-support/`, `security/`, `vulnerabilities/` for the larger ones), listed in `CORE_CHECKS` in `modules/core/index.ts`.

## Texts and languages

The agent speaks English and German. Checks never build a sentence: titles, causes, summaries, stat labels and error messages are `Text` values (`agent/src/i18n/text.ts`), a message key with named parameters, rendered per request in the language the app sends (`l` in the sealed request), or in `LANGUAGE` for notifications, the weekly report and the pairing banner. Why it is built this way: [decisions/0006](decisions/0006-agent-languages.md).

**Adding a text**

1. Add the key to `agent/src/i18n/messages.de.ts`, the reference catalog: a string, or a function of named parameters for inserted values and plural forms.
   ```ts
   'harbor.unhealthy.title': (p: { name: string; n: number }) => `Harbor ${p.name}: ${p.n} ${p.n === 1 ? 'Komponente' : 'Komponenten'} gestört`,
   ```
2. Add the same key to `messages.en.ts`, written as English, not word for word. The catalog is checked with `satisfies Messages`, so a missing key, an extra key or a different parameter does not compile; `i18n.spec.ts` also checks that both read the same parameters.
3. Use it: `title: t('harbor.unhealthy.title', { name, n })`. Parameters are checked against the German entry. A string parameter also takes another `Text` (`age: ageText(ms)`), a list parameter a list of them.
4. What comes from the cluster (a condition's message, an alert, a name) is not translated: `raw(message)`, or `rawOr(message, t('…'))` for "the cluster's message, else ours".

No em or en dashes in either language. Specs render with `de(…)` / `en(…)` from `agent/src/testing/i18n.ts` and assert the sentence, or compare `Text` values directly.

**Adding a language**

1. Add it to `Language` / `LANGUAGES` in `protocol/src/envelope.ts` (agents that do not know it ignore it) and to `PROTOCOL.md`.
2. Write `agent/src/i18n/messages.<lang>.ts` and `components.<lang>.ts` with `satisfies Messages`, and add it to `CATALOGS` and `LANGS` in `text.ts`. The compiler lists every missing key.
3. Accept it in `parseLanguage` (`agent/src/config.ts`), the Helm value `language` and the docs; record the app's demo in it (`LANGUAGES` in `agent/scripts/export-demo.mjs`).

## Adding an action

Actions change the cluster, so they get more care: add the type to `IssueAction` in `checks/types.ts`, implement it in `actions/actions.service.ts` (from the stored action, never from request input), add it to `RUNNABLE` in the controller, give it a button and a confirmation question in `app/src/app/cluster/cluster-view.ts`, its label, description and done message in both agent catalogs (`action.<type>.*`), add its permission to `ACTION_PERMISSIONS` (and to `WRITE_ACTIONS` if it changes the cluster) in `agent/src/rbac/rules.ts`, run `npm run rbac`, list it in `ACTION_TYPES` (`settings/settings.service.ts`) so the app can switch it, declare it in the `actions` of the integrations that offer it, and document it in `docs/SECURITY.md`.

## App conventions

- Standalone components, `OnPush`, zoneless, signals. `inject()` instead of constructor parameters.
- No getters and no method calls in templates: derive a view model in one `computed()` (see `buildClusterView`). Event handlers are fine.
- Always braces for `if`.
- Every text in English and German: a key in `app/src/app/i18n/en.ts` and `de.ts`, read in templates with `*transloco="let t"` and `t('key')`, in pure view-model builders through a `Translator` (`translatorFor(lang)`). Numbers, sizes and times go through `format.ts` with the language. The app follows the device language; the switch at the foot of the cluster list overrides it.
- Sentence case, no em or en dashes, in both languages.
- New ionicon: add it to the list in `scripts/generate-icons.mjs` and run `npm run icons`.
- Every new screen must work at phone width (no horizontal scroll), in dark and light mode, with reduced motion.

## Native apps

`app/ios` (Swift Package Manager, no CocoaPods) and `app/android` are committed Capacitor 8 projects.

```sh
cd app
npm run build:ios                         # ng build + cap sync ios; or build:android
npx cap open ios                          # or android: Xcode / Android Studio
```

They register the pairing scheme `kubernanny://` (the app listens in `app.ts`, `appUrlOpen`), allow plain HTTP to agents (every call is end-to-end encrypted), keep Android backups off (device keys) and carry icons and splash screens from `npm run native-assets`. Details, the store setup and the release commands: [RELEASING.md](RELEASING.md). After adding a Capacitor plugin, check the merged Android manifest for required `uses-feature` entries (RELEASING.md says how).

## Releases

- Every push to `main` builds `ghcr.io/<owner>/kubernanny:<YYYY-MM-DD>-<run>` and `:edge` for amd64 and arm64.
- A tag `vX.Y.Z` builds `:X.Y.Z` and `:latest` and pushes the chart to `oci://ghcr.io/<owner>/charts/kubernanny` with that version.
- The iOS and Android apps are released separately with `cd app && npm run release` (tags `app-vX.Y.Z`, which CI ignores): [RELEASING.md](RELEASING.md).
- Bump `version` / `appVersion` in `deploy/helm/kubernanny/Chart.yaml`, the image tag in `deploy/install.yaml`, `AGENT_VERSION` in `agent/src/app.controller.ts`, and add a `CHANGELOG.md` entry first.
