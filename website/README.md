# kubernanny.app

The public website: a landing page plus every markdown file in [`../docs`](../docs), prerendered to plain static HTML and deployed to Cloudflare Pages.

The imprint and the controller's details live in [`src/site.config.ts`](src/site.config.ts) (`LEGAL`). `/privacy` ([`src/app/pages/privacy.page.ts`](src/app/pages/privacy.page.ts)) covers the website, the demo, the app, the public relay and native push; keep it in step when any of them starts processing other data.

```sh
npm ci
npm run dev           # http://localhost:5173, live reload on changes in ../docs too
npm run build         # prerenders every route into dist/analog/public
npm run preview       # serves the build like Cloudflare Pages does (port 4321)
npm test              # markdown rendering, link rewriting, and a check of every link in docs/
npm run typecheck
npm run screenshots   # after a build: / and /docs/protocol at 390 and 1440 px, dark and light -> screenshots/
npm run brand         # re-renders public/og.png, apple-touch-icon.png, favicon-32.png from branding/
```

`screenshots` and `brand` use Playwright with a preinstalled Chromium (a local `playwright` dependency or the global one). Any route works: `node scripts/screenshots.mjs /docs/architecture`.

## Why Analog

[Analog](https://analogjs.org) 3.0.0 supports Angular 22 (its peer ranges include `^22.0.0`), so the site uses it as asked: file-based routes in `src/app/pages`, Vite, and static prerendering through its Nitro plugin, with the same Angular idioms as the app (standalone components, signals, OnPush, zoneless).

What it does **not** use is Analog's own content pipeline (`@analogjs/content`, `injectContent`). That reads markdown from `src/content` and renders it partly in the browser; the docs here live in `../docs` and need their links rewritten, GitHub heading ids, a table of contents and diagrams. A small Vite plugin ([`build/vite-plugin-docs.ts`](build/vite-plugin-docs.ts)) renders them at build time instead:

- `marked` with a custom renderer, `shiki` for code (dual light/dark theme as CSS variables), all in [`build/markdown.ts`](build/markdown.ts).
- Every page is its own lazily loaded chunk (`virtual:kubernanny-doc/<slug>`), loaded by a route resolver, so the prerendered HTML and the hydrating browser render the same thing.
- The pages ship as HTML; the browser never parses markdown.

Analog 3.0.0 was released on the day this was built (2026-11-24). Two things to know:

- `h3@1` is a direct dependency: `@analogjs/vite-plugin-nitro` runs on nitropack 2 (h3 1), while `@analogjs/router` would otherwise pull h3 2 to the top level, and the prerender then fails with `Cannot read properties of undefined (reading 'get')`. Drop the pin when the Nitro plugin moves to Nitro 3.
- If a later Analog release breaks, the fallback is a plain Angular 22 app with `@angular/ssr` and `outputMode: "static"`: the plugin, the renderer and all components carry over unchanged; only `vite.config.ts`, the `pages/` file names and `main.server.ts` would change.

## How the docs become pages

| In `docs/` | On the site |
|---|---|
| `README.md` | `/docs` |
| `PROTOCOL.md` | `/docs/protocol` |
| `decisions/README.md` | `/docs/decisions` |
| `decisions/0001-noise-ik-per-request.md` | `/docs/decisions/0001-noise-ik-per-request` |
| a link to another doc (`SECURITY.md#threats`) | that route plus the fragment |
| a bare `#fragment` | the page's own route plus the fragment |
| an image in `docs/` (`screenshots/05-overview-red.png`) | `/docs-media/screenshots/05-overview-red.png`, with width and height read from the PNG (no layout shift) |
| anything else in the repo (`../protocol/test/vectors.json`) | its page on GitHub |
| ```` ```mermaid ```` | a diagram, drawn in the browser; mermaid is only loaded on pages that have one |

Nothing is copied: the build reads `../docs` from the same commit. A new markdown file appears automatically under "More" in the sidebar; give it a place in `NAV` in [`build/docs-source.ts`](build/docs-source.ts). The landing page reads the component catalog from `docs/COMPONENTS.md`, so its count stays true.

`npm test` renders the real `docs/` folder and fails when a link between docs points at a page or heading that does not exist.

## Layout

```
build/                 build-time Node code: doc paths, markdown, the Vite plugin, the route list (+ tests)
scripts/postbuild.ts   route/index.html -> route.html, 404.html, sitemap.xml; fails if a route did not prerender
scripts/serve.ts       local static server with Cloudflare Pages' routing
scripts/*.mjs          screenshots, brand images
src/site.config.ts     names, links, install commands, the imprint data
src/app/pages/         routes (Analog file routing); docs.page.ts is the docs layout
src/app/landing/       sections of the landing page; screenshots.ts lists every screenshot used
src/app/components/    header, footer, icon, the nanny with the animated eye, doc view
src/styles.css         tokens from the app (docs/DESIGN.md), dark by default, light via prefers-color-scheme
src/styles/prose.css   rendered markdown
public/                favicon, OG image, robots.txt, _headers
```

Fonts (Bricolage Grotesque, Figtree) are bundled from `@fontsource-variable`; the site makes no third-party requests. All motion (the eye, the heartbeat, the handshake dot) is opted into under `prefers-reduced-motion: no-preference`. There is deliberately no blanket "zero every duration" rule: it breaks mermaid's layout.

## Deployment

`.github/workflows/website.yml` runs on pushes to `main` that touch `website/**`, `docs/**` or `branding/**` (and checks pull requests without deploying): typecheck, tests, build, then `wrangler pages deploy` of `dist/analog/public` to the Pages project `kubernanny`.

One-time setup:

1. **Create the Pages project.** Cloudflare dashboard → Workers & Pages → Create → Pages → "Direct Upload", name `kubernanny`, production branch `main`. (Or `npx wrangler pages project create kubernanny --production-branch main`.) Do not connect the Git repository: the workflow uploads the build.
2. **API token.** My Profile → API Tokens → Create Token → "Edit Cloudflare Workers" template, or a custom token with *Account → Cloudflare Pages → Edit*. Add it as the repository secret `CLOUDFLARE_API_TOKEN`, and the account id (dashboard sidebar, "Account ID") as `CLOUDFLARE_ACCOUNT_ID`.
3. **Custom domain.** Pages project → Custom domains → Set up a domain → `kubernanny.app` (and `www.kubernanny.app` if wanted, redirected with a Bulk Redirect or a Page Rule). With the zone on Cloudflare the DNS record is created for you; otherwise add the CNAME it shows.
4. Optional: a GitHub environment named `website` (the deploy job uses it) with a required reviewer, if deploys should wait for approval.

Routing: every page is written as `route.html` (`/docs/protocol` → `docs/protocol.html`), which Pages serves at the extension-less URL without a redirect, matching the canonical URLs in the pages and the sitemap. Unknown paths get `404.html` with status 404. `public/_headers` sets a strict Content-Security-Policy (inline scripts and styles are allowed because Angular's hydration and event replay and the diagrams need them) and long caching for the hashed `/assets/`. Check the first deploy with the browser console open; this was verified with the local preview server only.
