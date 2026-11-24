# Kubernanny app

Angular 22 (zoneless, signals), Ionic 8, Capacitor 8. One code base for iOS, Android and the web UI the agent serves.

```sh
npm ci
npm start                   # http://localhost:4200, pair with an agent (npm run start:demo in ../agent)
npm test                    # view models, formatting, charts, pairing links, icons
npx ng build                # dist/app/browser, also what the agent image serves
npm run icons               # regenerate src/app/core/icons.ts after catalog or UI icon changes
```

| Directory | Contents |
|---|---|
| `src/app/core` | API types and client, cluster and status stores, formatting, icons |
| `src/app/clusters` | cluster list and first-run page |
| `src/app/cluster` | one cluster: hero, tabs, component sheet, view models |
| `src/app/pair` | pairing from a link, QR code or typed code |
| `src/app/cluster-form` | settings, agent info, test notification, pair another device |
| `src/app/ui` | heartbeat, area chart, meter, issue list, logs modal |

Native builds, URL scheme and conventions: [../docs/DEVELOPMENT.md](../docs/DEVELOPMENT.md). Design: [../docs/DESIGN.md](../docs/DESIGN.md).
