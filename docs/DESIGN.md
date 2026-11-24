# Design

Kubernanny is looked at in two situations: a glance to confirm all is well, and a tense minute when it is not. The design serves both and nothing else.

## Principles

1. **One answer first.** The top of every cluster says, in one sentence, whether something needs you ("3 Ausfälle und 13 Warnungen", "Alles läuft"). Everything else is below the fold.
2. **Only what is broken.** The overview lists problems, not resources. Healthy components appear in the Dienste tab, quietly.
3. **Cause and remedy together.** Every problem says why, and offers the one action that usually fixes it right where it is described.
4. **Colour repeats, never carries.** Status is always also a word or an icon. The heartbeat has an accessible label.
5. **One memorable element.** The heartbeat line. Everything around it stays calm.

## The heartbeat

An ECG-like trace under the cluster name, in the status colour (`ui/heartbeat.ts`):

| State | Trace | Kubernanny travels in |
|---|---|---|
| green | regular beats | 3.4 s |
| yellow | an early, smaller extra beat per cycle | 2.6 s |
| red | fast, uneven, higher spikes | 1.5 s |
| unknown | flat line | no movement |

The path is generated deterministically, so it never jumps between renders. With `prefers-reduced-motion` the bright pulse does not move.

## Tokens

Dark is the primary mode (people check at night); light has its own steps, not an inversion. Defined in `app/src/styles.scss`.

| Token | Dark | Light | Use |
|---|---|---|---|
| `--ground` | `#0f1626` | `#f3f5f9` | page |
| `--surface` | `#172036` | `#ffffff` | cards, lists |
| `--raise` | `#1f2a46` | `#e9edf5` | chips, tracks, pressed |
| `--ink` / `--ink-2` / `--mute` | `#e9edf7` / `#c3cbe0` / `#8d97b5` | `#121a2c` / `#3a445e` / `#5b6582` | text levels |
| `--ok` | `#36d6a8` | `#0e9f77` | healthy |
| `--warn` | `#f5b83d` | `#b97800` | warning |
| `--crit` | `#ff5d73` | `#d92d4a` | critical |
| `--accent` / `--chart` | `#8ea2ff` | `#4d5fd6` | interactive, chart series |

Status colours are reserved for status. Charts use `--chart`, never a status colour, so a CPU curve never looks like an alarm.

## Type

- **Bricolage Grotesque** (variable, condensed width for the cluster name): names, headings, numbers.
- **Figtree** (variable): everything else.
- Tabular figures everywhere (`font-feature-settings: 'tnum'`), so values do not jitter when they update.
- Both fonts are bundled (`@fontsource-variable/*`): the app works offline and loads nothing from third parties.

## Layout

- **Phone**: one column. Hero, sticky tab bar, the tab's content.
- **From 980 px**: the hero (name, heartbeat, headline, score, six vital numbers) stays on the left; the tabs scroll on the right.
- Cards use three radii by role: 20 px for list containers and node cards, 14 px for tiles, 8 px for small controls. Problems are a single list with a coloured left rail, not separate cards.

## Charts

Single series, so no legend: the title names it, the current value sits top right. A 2 px line with a soft fill, two recessive gridlines, start and end on the time axis, the maximum in the middle. Hover or touch shows a crosshair with value and time. Ratios are drawn against 100 %, other units against their own peak. Nodes get small multiples (one CPU and one RAM chart each) instead of one chart with three colours.

## Copy

German, informal, plain verbs, sentence case. No em dashes. Numbers in German format ("1,5 GiB", "5,40 Kerne"). Errors say what happened and what to do ("Agent nicht erreichbar. Bist du im VPN?"). Kubernetes terms stay as they are (Pod, Deployment, CrashLoopBackOff): the audience knows them, and translating them would hide them from search.
