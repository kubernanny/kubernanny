# Design

Kubernanny is looked at in two situations: a glance to confirm all is well, and a tense minute when it is not. The design serves both and nothing else.

## Principles

1. **One answer first.** The top of every cluster says, in one sentence, whether something needs you ("3 Ausfälle und 13 Warnungen", "Alles läuft"). Everything else is below the fold.
2. **Only what is broken.** The overview lists problems, not resources. Healthy components appear in the Dienste tab, quietly.
3. **Cause and remedy together.** Every problem says why, and offers the one action that usually fixes it right where it is described.
4. **Colour repeats, never carries.** Status is always also a word or an icon. The nanny's eye has an accessible label.
5. **One memorable element.** The nanny's eye, from the app icon. Everything around it stays calm.
6. **No score.** The headline with its counts says how a cluster is; a number out of 100 only invites a second question.

## The nanny's eye

The nanny's glasses from the app icon (`branding/kubernanny-*.svg`, `ui/nanny-eye.ts`): the left lens has a dark pupil, the right one is the cluster's light with a soft glow. It sits next to the headline in the hero and in the top right of each cluster card.

| State | Right lens |
|---|---|
| green | mint `#36d6a8` (`--ok`) |
| yellow | amber `#f5b83d` (`--warn`) |
| red | coral `#ff5d73` (`--crit`) |
| unknown | an empty grey ring, no glow |

It only moves while a check runs: the glow breathes slowly. In the hero a thin ring around the right lens fills towards the next scheduled check (`nextCheckAt`); tapping the eye checks at once. With `prefers-reduced-motion` the glow stays still and the ring moves in five-second steps.

## Module sheets

A component's sheet answers "what is it doing?" in three layers:

1. **Key figures**: one row of two to four numbers (`stats`), never a half-filled grid. Four become two by two on a phone. A module that has more to say puts it in a list.
2. **Problems**: the module's issues, with their actions.
3. **Its objects** (`details`): a list per kind (database clusters, volumes, apps, certificates) or a short table (targets per job, Longhorn nodes). Problems come first, on a raised surface with a coloured rail; every component also lists its workloads with their pods ("Laufzeit") and its volumes; healthy rows are compact, and after five of them the rest folds behind "Show all". Facts under a name (last backup, WAL archiving, replicas) are small text, coloured only when they are the problem.

## Resources

CPU and RAM are one component everywhere (`ui/resource-bar.ts`: hero vitals, overview figures and per node, node cards, opened workloads): a loading bar whose track is the capacity (allocatable; for a workload its limit, else its request).

- **Reserved** (requests): a soft, finely striped layer from the left at full height, always visible.
- **Used**: the solid bar in the figure's tone, inset 2 px so the reserved layer shows around it, with a bright tip; its width animates (not with reduced motion).
- **Limit**: a marker with a small cap at the sum of the limits. Limits above the capacity put the marker at the end and an amber striped cap after it ("+60 % überbucht").
- **Legend** right under the bar, one swatch each: "1,73 genutzt", "1,15 reserviert", "1,60 Limit + 8 Pods ohne Limit". The header keeps "43 % 1,73 / 4 Kerne".
- CPU is always in cores with the locale's decimals (0,40, never 400m), RAM in MiB/GiB.
- Tone: coral from 90 % use; amber from 80 % use, or when requests take 90 % (nothing more can be scheduled there).
- 12 px high, 8 px in lists (`compact`). One `role="meter"` with an aria label naming all values.

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
- **From 980 px**: the hero stays on the left as a rail (name, eye with the countdown ring, headline, "Geprüft vor 12 s · nächste in 48 s"; then nodes, pods, volumes and addresses in one row, two by two where the rail is narrow; then CPU and RAM across the full width with a one-line legend and a thin bar per node, problem nodes first). The tabs scroll on the right; the overview's own figures and per-node section are for phones only.
- Cards use three radii by role: 20 px for list containers and node cards, 14 px for tiles, 8 px for small controls. Problems are a single list with a coloured left rail, not separate cards.

## Charts

Single series, so no legend: the title names it, the current value sits top right. A 2 px line with a soft fill, two recessive gridlines, start and end on the time axis, the maximum in the middle. Hover or touch shows a crosshair with value and time. Ratios are drawn against 100 %, other units against their own peak. Nodes get small multiples (one CPU and one RAM chart each) instead of one chart with three colours.

## Copy

German, informal, plain verbs, sentence case. No em dashes. Numbers in German format ("1,5 GiB", "5,40 Kerne"). Errors say what happened and what to do ("Agent nicht erreichbar. Bist du im VPN?"). Kubernetes terms stay as they are (Pod, Deployment, CrashLoopBackOff): the audience knows them, and translating them would hide them from search.
