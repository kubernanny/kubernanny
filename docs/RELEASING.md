# Releasing

For maintainers: how the agent, the chart, the relay, the website and the apps get released, and what has to be in place on the machine that does it. This page is not published on kubernanny.app.

- **Agent, chart and relay image**: CI, from a `vX.Y.Z` tag ([below](#agent-chart-and-relay)).
- **The apps**: fastlane (`fastlane/`, `Gemfile`) behind a few npm scripts in `app/`, run by hand ([Commands](#commands)).
- **Website and public relay**: deployed by their workflows on every push to `main` ([Infrastructure](#infrastructure)).

## Agent, chart and relay

- Every push to `main` builds `ghcr.io/kubernanny/agent:<YYYY-MM-DD>-<run>` and `:edge`, and `ghcr.io/kubernanny/relay:edge`, for amd64 and arm64, signed with cosign (keyless, the workflow's identity).
- A tag `vX.Y.Z` builds `agent:X.Y.Z`, `relay:X.Y.Z` and both `:latest`, and pushes the chart to `oci://ghcr.io/kubernanny/charts/kubernanny` with that version.
- The app's tags are `app-vX.Y.Z`, which do not match CI's `v*` trigger.

A release of the agent:

1. Bump `version` and `appVersion` in `deploy/helm/kubernanny/Chart.yaml`, the image tag in `deploy/install.yaml` and `AGENT_VERSION` in `agent/src/version.ts` (and `KNOWN_AGENT_VERSION` in `app/src/app/core/version.ts`, so the app offers the update).
2. Add the `CHANGELOG.md` entry.
3. Commit, tag `vX.Y.Z`, push both.
4. The first time only: make the GHCR packages `agent`, `relay` and `charts/kubernanny` public (organisation → Packages → package settings), and optionally add the chart repository to Artifact Hub.

## Commands

Run them in `app/`.

| Command | What it does |
|---|---|
| `npm run release` | The whole release, to testers only. Refuses with uncommitted changes, shows this version's release notes and asks once, bumps `app/package.json` (patch by default; `-- minor`, `-- major` or `-- 1.2.0`), commits, tags `app-vX.Y.Z`, pushes when there is an `origin`, then uploads Android to the internal test track and iOS to TestFlight with the App Store version prepared (texts, release notes, review notes) but **not** submitted. |
| `npm run release:continue` | Uploads the current version again, without a bump: for a stopped release, or iOS following on a Mac. `SKIP_ANDROID=1` / `SKIP_IOS=1` leave a platform out. Both stores get the next free build number. |
| `npm run release:production` | Sends the tested builds for review. Android: promotes the newest internal build to production (with managed publishing it then waits for "Publish" in the Play Console). iOS: submits the prepared version with its newest build; it goes live by hand after approval, or by itself with `AUTO_RELEASE=1`. Safe to run twice. |
| `npm run store:metadata` | Uploads the listing texts in `fastlane/metadata/` and the App Review notes to both stores. |
| `npm run store:shots` | Renders the store screenshots into `fastlane/screenshots/` ([Screenshots](#screenshots)). |
| `npm run store:screenshots` | Replaces the screenshots in both stores with `fastlane/screenshots/`, plus the Play icon and feature graphic. |
| `npm run build:ios` / `npm run build:android` | Web build plus `cap sync` for development; then `npx cap open ios` / `npx cap open android`. |
| `npm run native-assets` | Renders icons, splash screens and the Play graphics from `branding/kubernanny-ok.svg`. Commit the PNGs. |

Switches: `RELEASE_YES=1` answers the question with yes, `ALLOW_DIRTY=1` skips the clean-tree check, `PUSH=0` keeps commit and tag local, `VERSION_CODE=…` forces an Android version code, `PLAY_RELEASE_STATUS=draft` uploads Play releases as drafts (only needed until the app's first production release on Play).

One platform or one step alone: `bundle exec fastlane ios beta`, `… android metadata`, `… ios build` (build and sign only; the IPA lands in `fastlane/build/`, the AAB in `app/android/app/build/outputs/bundle/release/`). `bundle exec fastlane lanes` lists them all.

| Lane | |
|---|---|
| `ios beta` / `android beta` | build, sign, upload to TestFlight / the internal track with the release notes |
| `ios release` / `android release` | submit for review / promote to production |
| `ios metadata` / `android metadata` / `metadata` | listing texts (one store / both) |
| `ios screenshots` / `android screenshots` / `screenshots` | screenshots and Play graphics (one store / both) |
| `ios build` / `android build` | build and sign only |

## Versioning

- **The version** is `version` in `app/package.json`, and nothing else. Android reads it in `app/android/app/build.gradle`; iOS gets it as `MARKETING_VERSION` at build time, and `npm run release` also writes it into the Xcode project. App versions are independent of the agent's.
- **Build numbers** are never committed: iOS takes the next free one of this version on TestFlight, Android one above the highest version code on any Play track. A rebuild of the same version just works.
- **Release notes**: `fastlane/release-notes/de-DE.txt` and `en-US.txt`, written by hand before each release and committed with it. Both stores get the same text, so no platform-specific words, and under 500 characters (Play's limit; the lanes refuse longer ones). The release warns when they are unchanged since the last app tag. German with "du", no em or en dashes.

## macOS or Linux

| | macOS | Linux |
|---|---|---|
| iOS build and upload (`ios beta`, `ios build`) | yes, needs Xcode | no: `npm run release` skips iOS with a note; finish on a Mac with `SKIP_ANDROID=1 npm run release:continue` |
| iOS submit, texts, screenshots | yes | yes (App Store Connect API only) |
| Android everything | yes, JDK 21 and the Android SDK | yes, same |
| keystore password | macOS keychain or environment | environment only |

## One-time setup

The store accounts, the app records, the identifiers and App Groups, the store forms and the Firebase project exist. A new machine or a new maintainer needs:

1. Ruby from Homebrew (`brew install ruby`; macOS's own is too old) and `bundle install` at the repository root; JDK 21 and the Android SDK (Android Studio); Xcode on a Mac. No CocoaPods: the iOS project uses Swift Package Manager.
2. The credentials in `~/.config/kubernanny-store/` (another place with `KUBERNANNY_STORE_DIR`), then `chmod 700 ~/.config/kubernanny-store && chmod 600 ~/.config/kubernanny-store/*`:
   ```
   asc-api-key.json            App Store Connect API key, fastlane format
   asc-api-key.p8              the same key as downloaded (xcodebuild needs the file)
   play-service-account.json   Google Play service account key
   upload-keystore.jks         Android upload key (back it up; a reset through Play support takes days)
   store.env                   KUBERNANNY_APPLE_TEAM_ID, KUBERNANNY_UPLOAD_KEY_ALIAS (default upload),
                               KUBERNANNY_REVIEW_FIRST_NAME / _LAST_NAME / _PHONE / _EMAIL (App Review contact);
                               on Linux also KUBERNANNY_UPLOAD_KEYSTORE_PASSWORD
   google-services.json        Firebase, Android app app.kubernanny (native push)
   GoogleService-Info.plist    Firebase, iOS app app.kubernanny (native push)
   ```
3. On macOS the keystore password in the keychain: `security add-generic-password -s kubernanny-upload-keystore -a kubernanny -w`.
4. The App Store Connect API key needs the role **Admin**: only Admin keys may use Apple's cloud-managed distribution certificate (which is why there is no `Matchfile`), and a key's role cannot be changed later. Automatic signing with `-allowProvisioningUpdates` keeps the profiles of the three identifiers `app.kubernanny`, `app.kubernanny.PushExtension` and `app.kubernanny.KubernannyWidget` and the App Groups `group.app.kubernanny` and `group.app.kubernanny.push` in order.
5. The store answers are set and only need a look when the app starts collecting data or talking to a new service: App Privacy "Data Not Collected" (privacy policy https://kubernanny.app/privacy), Play Data safety "no data collected, none shared, encrypted in transit", the Play app access text (the built-in demo), age rating 4+ / content rating all "no", target audience 18+, category Developer Tools / Tools. Export compliance: [Encryption](#encryption).

## The native projects

`app/ios` and `app/android` were created with `npx cap add` (Capacitor 8, iOS with Swift Package Manager) and are committed. `npx cap sync` copies the web build and the plugins and never touches the changes below. iOS: deployment target 15.0, iPhone and iPad, app id `app.kubernanny`. Android: minSdk 24, targetSdk and compileSdk 36 (`app/android/variables.gradle`).

What the projects add, and must keep:

- **Pairing links** `kubernanny://pair?…`: `CFBundleURLTypes` in `Info.plist`, an intent filter for scheme `kubernanny` and host `pair` in the manifest. The app parses them in `app/src/app/core/pairing-link.ts` and pairs only after the person confirmed.
- **QR scanner**: Android uses `@capacitor-mlkit/barcode-scanning`, only its `scan()` (Google's code scanner in Play services: no `CAMERA` permission, no camera `<uses-feature>`; the plugin's own decoder library is excluded in `app/android/app/build.gradle`). iOS uses `@capacitor/barcode-scanner` with `NSCameraUsageDescription`. Each is left out of the other platform by `includePlugins` in `capacitor.config.ts`.
- **Backups off on Android** (`allowBackup="false"`): a restored backup would bring the cluster list onto another phone without its keys. The keys live in the Android Keystore and the iOS Keychain with "this device only" access.
- **Icons and splash screens** from `npm run native-assets`.

### Plain HTTP to agents

Agents are often reached as `http://` in a home network or VPN. That is safe because every call is end-to-end encrypted against the agent key pinned at pairing ([PROTOCOL.md](PROTOCOL.md)); fetching a key that is not pinned yet is refused over plain HTTP by the app itself (`transportAllowed`). iOS: `NSAllowsArbitraryLoadsInWebContent` (not `NSAllowsLocalNetworking`, which misses LAN DNS and VPN names, and not `NSAllowsArbitraryLoads`, which iOS ignores next to it), plus `NSLocalNetworkUsageDescription`. Android: `res/xml/network_security_config.xml` permits cleartext, and `android.allowMixedContent` in `capacitor.config.ts` lets the WebView call `http://` agents.

The review notes (`fastlane/review-notes.txt`) carry the justification; if App Review asks again, this text answers:

> Kubernanny connects only to the user's own server (the Kubernanny agent in their Kubernetes cluster), which is often reachable only by plain HTTP inside a home network or VPN, where certificates are rare. Every request and response is end-to-end encrypted and authenticated with the Noise protocol: the device has its own key pair and the server's public key is pinned when the device is paired. The transport therefore only carries ciphertext, and the ATS exception (limited to the web view, which makes all of the app's requests) does not weaken confidentiality or integrity.

### Native push

`build_web` in the Fastfile copies the two Firebase files from `~/.config/kubernanny-store/` to `app/android/app/` and `app/ios/App/App/` before `cap sync`. Without them the build goes on, says so, and has no push (the app hides the option). The Notification Service Extension `KubernannyPushExtension` is in the Xcode project, added by `cd app && bundle exec ruby scripts/add-push-extension.rb` (idempotent: run it again after adding a source file to the extension or if the project is ever regenerated). FCM reaches iPhones through the APNs key uploaded in the Firebase console.

The app receives the widget's hourly silent status push as an APNs background push (`UIBackgroundModes` = `remote-notification`, set by the same script). If App Review asks about it, this answers: "Kubernanny uses remote notifications only to receive a silent, end-to-end encrypted status update of the user's own Kubernetes cluster, about once an hour, when the user has placed a Kubernanny home-screen widget. The app decrypts it on the device, updates the widget's data and returns at once. No content is shown, no audio, location or other background work."

When a change touches the relay, the agent and the app together (as the dead man's switch did), deploy in that order: relay, agents, app.

### Android: no required hardware features

A plugin's manifest may declare `<uses-feature>` without `android:required`, which defaults to `true`; Google Play then hides the app from every device without that hardware. **After adding a plugin**, check the merged manifest:

```sh
cd app/android && ./gradlew :app:processReleaseMainManifest
grep -o '<uses-feature[^>]*>' app/build/intermediates/merged_manifest/release/processReleaseMainManifest/AndroidManifest.xml
```

Every line must carry `android:required="false"` unless the app cannot work without that hardware. To override a plugin, repeat its declaration in `app/android/app/src/main/AndroidManifest.xml` with `android:required="false" tools:replace="android:required"`; without `tools:replace` the merge uses OR semantics, where one `true` wins.

### Widgets

How the widgets work: [ARCHITECTURE.md, Widgets](ARCHITECTURE.md#widgets). For the build:

- **Android**: nothing to do. `app/native/widget-bridge` carries both widgets and their receivers in its own manifest, which the merger adds; no `<uses-feature>`, no permission.
- **iOS**: the extension `KubernannyWidget` (bundle id `app.kubernanny.KubernannyWidget`, sources in `app/ios/App/KubernannyWidget/`) was added by `cd app && bundle exec ruby scripts/add-widget-extension.rb`. Run it again after adding a source file to the widget (it adds the files of its `SOURCES` list that the target lacks). App, widget and push extension must all have the App Group `group.app.kubernanny`, or the widget stays empty.

### Encryption

The app implements end-to-end encryption itself (Noise with `@noble/*`, HPKE for push, [PROTOCOL.md](PROTOCOL.md)), so "Does your app use encryption?" is answered yes. The answer given in App Store Connect: standard encryption algorithms only; not available in France (deselected under Pricing and Availability). **Pending**: Apple has to approve the export compliance documentation. Until then App Store Connect asks for every build, and a TestFlight build shows "Missing Compliance" until it is answered. Once approved, add to `app/ios/App/App/Info.plist` (with the code Apple issues, if any) and commit:

```xml
<key>ITSAppUsesNonExemptEncryption</key>
<true/>
<key>ITSEncryptionExportComplianceCode</key>
<string>…</string>
```

## Listing texts, review notes, screenshots

- **Texts**: `fastlane/metadata/ios/<locale>/` and `fastlane/metadata/android/<locale>/`, German and English, one file per field; then `npm run store:metadata`. No em or en dashes, nothing about other mobile platforms in the iOS texts (guideline 2.3.10), generic keywords only. Limits: name and subtitle 30, keywords 100, promotional text 170, Play short description 80, descriptions 4000 characters.
- **App Review notes**: `fastlane/review-notes.txt` (English): how to review without a cluster (the built-in demo) and the ATS justification. Keep the demo button's label in step with the app.

### Screenshots

`npm run store:shots` (`scripts/store-screenshots/run.sh`) renders the store screenshots; how it works is described at the top of that script.

- It starts the three demo agents of the docs screenshots, takes eight screens in English and German, frames them like a store gallery and checks sizes and counts. Sizes and devices are in `targets.cjs`: iPhone 6.9" and iPad 13" for the App Store, phone and ten-inch tablet for Play.
- `SKIP_BUILD=1` reuses the existing builds; `ONLY=iphone69,phone` renders only those sizes. To change only a headline or the frame, edit `frame/texts.cjs` or `frame/template.html` and run `NODE_PATH=e2e/node_modules node scripts/store-screenshots/frame/frame.cjs`.
- Headlines: short, true, the same in both languages (German with "du"), no em or en dashes.
- The rendered files (about 50 MB) are not committed. Look at every picture, then `npm run store:screenshots`.

## Before each release

On real devices, what can regress without a test noticing:

- Pairing by QR code and by a `kubernanny://pair?…` link (cold start and running app), against an `http://` agent in the LAN and an `https://` one, iOS and Android.
- Push: switch it on in a cluster's settings, a test push with the app in the background and with the phone locked.
- The dead man's switch, when the relay, the push code or the protocol changed: grace 10 minutes, `kubectl -n kubernanny scale deploy/kubernanny --replicas 0`, the message arrives with your sign and the widget says "Agent not answering"; scale back, the "reachable again" push follows.
- Widgets on both platforms: red, yellow and green clusters, a tap opens the cluster, the entries turn grey after 2 hours without news, a push updates them with the app closed, largest text size, German and English.
- Light and dark, the largest system text size, the demo without a cluster.

## Infrastructure

| What | Deployed by | Secrets |
|---|---|---|
| Images and chart (`ghcr.io/kubernanny/*`) | `ci.yml`, on `main` and `v*` tags | `GITHUB_TOKEN` only |
| Website kubernanny.app (Cloudflare Pages project `kubernanny`, direct upload) | `website.yml`, on changes to `website/`, `docs/`, `branding/` | `CLOUDFLARE_API_TOKEN` (Account → Cloudflare Pages: Edit), `CLOUDFLARE_ACCOUNT_ID` |
| Public relay relay.kubernanny.app (the Worker in `relay/cloudflare`, `RELAY_PUBLIC_URL` pinned) | `relay.yml`, on changes to `relay/cloudflare`, `relay/src`, `protocol` | the same token, which also needs Account → Workers Scripts: Edit and, on the zone `kubernanny.app`, Workers Routes: Edit and DNS: Edit; the FCM service account as a Worker secret |

The relay's rate limiting rule for `/v1/agents/*/ws` and the custom domains live with the zone `kubernanny.app` in Cloudflare. The website's `/privacy` covers the website, the demo, the app, the public relay and native push: keep it in step when any of them starts processing other data.
