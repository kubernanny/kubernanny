# 0006: The agent speaks the app's language

**Status**: accepted

## Context

Every sentence the agent produces was German, written straight into the checks: issue titles and causes, module summaries, stat labels, settings texts, action results, error messages, pushes, the weekly report, the pairing banner. The app gets an English UI, and the open-source audience is mostly English. One agent serves several devices, and two people sharing a cluster may read different languages, so the agent cannot simply be "an English agent" or "a German agent". Two constraints shape the answer: the checks run once a minute, not per request, and the judgement functions (`evaluate*`) should stay as easy to read and test as before.

## Decisions

**1. Checks return texts in no language.** A `Text` is `{ $t: key, p: params }` (`agent/src/i18n/text.ts`), built with `t('nodes.notReady.title', { node })`. Issue `title` and `cause`, module `name`, `description`, `summary`, stat labels, settings labels, history series labels, action results and API error messages are typed `Text`, so a forgotten German literal does not compile. Text from the cluster (a condition's message, an alert's summary, a component name, a user's own description) is `raw(text)`, the same in every language. Ids and every machine field are untouched.

Considered: a function `(lang) => string` per text. It reads about as well, but cannot be compared in tests (`toEqual`), cannot be logged, and cannot be stored next to the data it describes. Rendering both languages into `{ en, de }` at check time was also possible, but every new language would widen every type and double the snapshot again.

**2. One catalog per language, the German one is the reference.** `messages.de.ts` (plus `components.de.ts` for the catalog's one-line descriptions) defines the keys and their parameters; `Messages` is derived from it. `messages.en.ts` is checked with `satisfies Messages`: a missing key, an extra key or a parameter of another type is a compile error, and `t()` checks each call's parameters against the German entry. An entry is a string or a function of named parameters, which covers plural forms (``n === 1 ? '1 pod' : `${n} pods` ``) and per-language number formatting (`9,1` against `9.1`) without a format language or a library. A spec probes every entry with recording parameters to check both languages read the same placeholders, render no empty text and no em or en dash. German was kept word for word: it is reviewed copy. The English was written as English.

Parameters may themselves be texts (`age: ageText(ms)`, a fallback sentence) or lists of texts (the advisories of a vulnerability, the parts of a cause), rendered in the same language before the entry sees them. That keeps composed sentences (`"Last backup of db was 3 days ago"`) in one entry per language, where word order is free, instead of concatenating fragments.

**3. Rendering happens at the edge, per request.** The app sends its UI language in the sealed request (`l`, [PROTOCOL.md](../PROTOCOL.md)). `E2eService` hands it to the internal dispatch as the header `x-kubernanny-language`, which, like the principal header, is only believed on the internal socket. A global interceptor renders every `Text` in a response body (`localize`, a walk over plain objects and arrays), and an exception filter does the same for error bodies. So the snapshot is stored once per run with unrendered texts and rendered per request; rendering the broken demo's snapshot (22 issues, 36 modules) takes about 0.2 ms and grows linearly with it, not worth a cache. Without a language the agent uses `LANGUAGE` (`en` by default; Helm `language`).

Considered: rendering both languages once per run. Cheaper per request, but each new language would cost a full copy in memory and a code path, and errors thrown by services would still need rendering per request.

**4. What has no reader to ask uses `LANGUAGE`.** Pushes, the weekly report, the webhook JSON, the test notification, the pairing banner in the pod log and the admin CLI. A cluster shared by people with different languages gets its notifications in one; that is the price of not storing a language per device.

**5. Unknown languages are dropped, not refused.** The protocol only lets `en` and `de` through and ignores any other value, so an app that knows a third language still talks to an older agent, in that agent's default. `LANGUAGE` is read leniently for the same reason, and because glibc uses the same variable as a list like `de_DE:en`: the first entry counts, anything unknown is English.

**6. The order of issues no longer depends on their title.** Issues of the same severity and age used to be sorted by title, which would have made the order differ between languages. Ties now keep the order the modules reported them in.

## Consequences

- Adding a text is two catalog entries; adding a language is one catalog file per area plus the protocol value ([DEVELOPMENT.md](../DEVELOPMENT.md#texts-and-languages)).
- The app's built-in demo is recorded per language (`app/public/demo/<scenario>.<lang>.json`).
- Error messages of library calls (the Kubernetes API, Prometheus) stay as they come; only the agent's own words are translated.
- The `TextError` class lets a module throw a message people see (the vulnerability database is unreachable) and still have it rendered per request.
