# kubernanny.app

The public website: a landing page plus every markdown file in [`../docs`](../docs), prerendered to plain static HTML and deployed to Cloudflare Pages.

The imprint and the controller's details live in [`src/site.config.ts`](src/site.config.ts) (`LEGAL`). `/privacy` ([`src/app/pages/privacy.page.ts`](src/app/pages/privacy.page.ts)) covers the website, the demo, the app, the public relay and native push; keep it in step when any of them starts processing other data.

```sh
npm ci
npm run dev           # http://localhost:5173, live reload on changes in ../docs too
npm run build         # prerenders every route into dist/analog/public
npm run preview       # serves the build like Cloudflare Pages does (port 4321)
npm test              # markdown rendering, link rewriting, every link in docs/ and the READMEs, unused screenshots
npm run typecheck
npm run screenshots   # after a build: / and /docs/protocol at 390 and 1440 px, dark and light -> screenshots/
npm run brand         # re-renders public/og.png, apple-touch-icon.png, favicon-32.png from branding/
```

`screenshots` and `brand` use Playwright with a preinstalled Chromium (a local `playwright` dependency or the global one). Any route works: `node scripts/screenshots.mjs /docs/architecture`.

## Why Analog

[Analog](https://analogjs.org) gives file-based routes in `src/app/pages`, Vite and static prerendering through its Nitro plugin, with the same Angular idioms as the app (standalone components, signals, OnPush, zoneless). Its content pipeline (`@analogjs/content`) is not used: the docs live in `../docs` and need their links rewritten, GitHub heading ids, a table of contents and diagrams, so a small Vite plugin ([`build/vite-plugin-docs.ts`](build/vite-plugin-docs.ts)) renders them at build time with `marked` and `shiki` ([`build/markdown.ts`](build/markdown.ts)). Every page is its own lazily loaded chunk, and the browser never parses markdown.

`h3@1` is a direct dependency: `@analogjs/vite-plugin-nitro` runs on nitropack 2 (h3 1), while `@analogjs/router` would otherwise pull h3 2 to the top level and break the prerender (`Cannot read properties of undefined (reading 'get')`). Drop the pin when the Nitro plugin moves to Nitro 3. Should a later Analog release break, a plain Angular app with `@angular/ssr` and `outputMode: "static"` takes the plugin, the renderer and all components unchanged.

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

The Pages project, the token and the domain are set up once; their names and permissions: docs/RELEASING.md, "Infrastructure".

Routing: every page is written as `route.html` (`/docs/protocol` → `docs/protocol.html`), which Pages serves at the extension-less URL without a redirect, matching the canonical URLs in the pages and the sitemap. Unknown paths get `404.html` with status 404. `public/_headers` sets a strict Content-Security-Policy (inline scripts and styles are allowed because Angular's hydration and event replay and the diagrams need them) and long caching for the hashed `/assets/`. Check the first deploy with the browser console open; this was verified with the local preview server only.
