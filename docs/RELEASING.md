# Releasing the app (App Store and Google Play)

The agent and the chart are released by CI from a `vX.Y.Z` tag ([DEVELOPMENT.md](DEVELOPMENT.md#releases)). This page is about the native apps: how the iOS and Android projects are set up, the one-time store setup, and the commands that build, upload and submit them. Everything goes through fastlane (`fastlane/`, `Gemfile`) behind a few npm scripts in `app/`.

## Commands

Run them in `app/`.

| Command | What it does |
|---|---|
| `npm run release` | The whole release, to testers only. Refuses with uncommitted changes, shows this version's release notes (`fastlane/release-notes/`) and asks once, bumps `app/package.json` (patch by default; `npm run release -- minor`, `-- major` or `-- 1.2.0`), commits, tags `app-vX.Y.Z`, pushes when there is an `origin`, then builds and uploads both apps: Android to the internal test track, iOS to TestFlight with the App Store version prepared (texts, release notes, review notes) but **not** submitted. |
| `npm run release:continue` | Uploads the current version again, without a bump. For a stopped release (an upload failed, or iOS has to follow on a Mac). `SKIP_ANDROID=1` / `SKIP_IOS=1` leave a platform out, e.g. `SKIP_ANDROID=1` after only iOS failed. A second upload of the same version works: both stores get the next free build number. |
| `npm run release:production` | Sends the tested builds for review. Android: promotes the newest internal build to production (with managed publishing on in the Play Console it then waits for your click on "Publish"). iOS: submits the prepared version with its newest build; it goes live by hand after approval, or by itself with `AUTO_RELEASE=1`. A version that is already submitted is left alone, so running it twice is safe. |
| `npm run store:metadata` | Uploads the listing texts in `fastlane/metadata/` to both stores, plus the App Review notes. A release uploads the iOS texts anyway. |
| `npm run store:shots` | Renders the store screenshots into `fastlane/screenshots/` (all sizes, German and English) from three demo agents. Linux or macOS, needs Playwright with Chromium and Python 3 with Pillow. See [Screenshots](#listing-texts-review-notes-screenshots). |
| `npm run store:screenshots` | Replaces the screenshots in both stores with `fastlane/screenshots/`, plus the Play icon and feature graphic. |
| `npm run build:ios` / `npm run build:android` | Web build plus `cap sync` for development; then `npx cap open ios` / `npx cap open android`. No store involved. |
| `npm run native-assets` | Renders app icons, splash screens and the Play icon and feature graphic from `branding/kubernanny-ok.svg`. Run after changing the logo and commit the PNGs. Needs Playwright with Chromium. |

Other switches: `RELEASE_YES=1` answers the question with yes, `ALLOW_DIRTY=1` skips the clean-tree check, `PUSH=0` keeps commit and tag local, `PLAY_RELEASE_STATUS=draft` for an app that was never published (see below), `VERSION_CODE=…` forces an Android version code.

One platform or one step alone goes through fastlane at the repository root: `bundle exec fastlane ios beta`, `… android metadata`, `… ios build` (build and sign without uploading, to check signing; the IPA lands in `fastlane/build/`, the AAB in `app/android/app/build/outputs/bundle/release/`). `bundle exec fastlane lanes` lists them all.

| Lane | |
|---|---|
| `ios beta` / `android beta` | build, sign, upload to TestFlight / the internal track with the release notes |
| `ios release` / `android release` | submit for review / promote to production |
| `ios metadata` / `android metadata` / `metadata` | listing texts (one store / both) |
| `ios screenshots` / `android screenshots` / `screenshots` | screenshots and Play graphics (one store / both) |
| `ios build` / `android build` | build and sign only |

## Versioning

- **The version** is `version` in `app/package.json`, and nothing else. Android reads it in `app/android/app/build.gradle` (`versionName`); iOS gets it as `MARKETING_VERSION` at build time, and `npm run release` also writes it into the Xcode project so local builds show it. App versions are independent of the agent's: the tags are `app-vX.Y.Z`, which do not match CI's `v*` trigger.
- **Build numbers** are never committed. iOS: the next free build number of this version on TestFlight. Android: one above the highest version code on any Play track. So a rebuild of the same version (`release:continue`) just works.
- The first store release must be at least `1.0.0`: `npm run release -- 1.0.0`.
- **Release notes**: `fastlane/release-notes/de-DE.txt` and `en-US.txt`, written by hand before each release and committed with it. They go to the App Store version ("What's New") and to the Play release, for both stores the same text, so keep them free of platform-specific words, and under 500 characters (Play's limit; the lanes refuse longer ones). The release warns when they are unchanged since the last app tag.

## macOS or Linux

| | macOS | Linux |
|---|---|---|
| iOS build and upload (`ios beta`, `ios build`) | yes, needs Xcode | no: `npm run release` skips iOS with a note; finish on a Mac with `SKIP_ANDROID=1 npm run release:continue` |
| iOS submit, texts, screenshots (`ios release`, `ios metadata`, `ios screenshots`) | yes | yes (App Store Connect API only) |
| Android everything | yes, needs a JDK 21 and the Android SDK (Android Studio) | yes, same |
| keystore password | macOS keychain or environment | environment only |

Ruby: `bundle install` once at the repository root (fastlane is pinned in `Gemfile` / `Gemfile.lock`). The system Ruby of macOS is too old for current fastlane; use Homebrew's (`brew install ruby`) or rbenv. CocoaPods is **not** needed: the iOS project uses Swift Package Manager.

## The native projects

`app/ios` and `app/android` were created with `npx cap add` (Capacitor 8, iOS with Swift Package Manager: `cap add ios --packagemanager SPM`) and are committed. `npx cap sync` copies the web build and the plugins; it never touches the changes below.

- **iOS**: deployment target 15.0, iPhone and iPad. App id `app.kubernanny`. `Info.plist` adds the URL scheme, the App Transport Security exception and the local network text (below).
- **Android**: minSdk 24, targetSdk and compileSdk 36 (Capacitor 8's defaults, `app/android/variables.gradle`). `AndroidManifest.xml` adds the pairing intent filter, the network security config and turns backups off.
- **Pairing links** `kubernanny://pair?url=…&code=…&key=…` (the agent's QR code): `CFBundleURLTypes` in `Info.plist`, an intent filter for scheme `kubernanny` and host `pair` in the manifest. The app parses them in `app/src/app/core/pairing-link.ts` (`pairingRoute`, exact host `pair`) and pairs only after the person confirmed on the pairing page.
- **QR scanner** ("QR-Code scannen" on the start screen and in "Cluster hinzufügen"): one plugin per platform, each left out of the other by `includePlugins` in `capacitor.config.ts`. Android: `@capacitor-mlkit/barcode-scanning` (Apache-2.0), only its `scan()`, which is Google's code scanner in Play services: the camera runs there, the app declares no `CAMERA` permission and no camera `<uses-feature>`; on a fresh device the scanner module is downloaded on first use. The plugin's own ML Kit decoder (`libbarhopper_v3.so`, about 5 MB per ABI) is excluded in `app/android/app/build.gradle`, since the app never calls `startScan()` or `readBarcodesFromImage()`. iOS: `@capacitor/barcode-scanner` (Ionic, MIT; ML Kit has no Swift package), which needs `NSCameraUsageDescription` (German in `Info.plist`, German and English in `InfoPlist.strings`). The browser uses `BarcodeDetector` where it exists, else the button is hidden. Every scan goes through `scannedPairingRoute`, i.e. `pairingRoute`: the same rules as a link the system opens. The WebView runs under the CSP in `app/src/index.html` (no inline scripts; see [SECURITY.md](SECURITY.md#threats)): with an Android System WebView too old for Capacitor's document-start script, Capacitor's inline fallback is blocked.
- **Backups off on Android** (`allowBackup="false"`, `res/xml/data_extraction_rules.xml`): a restored backup would bring the cluster list onto another phone without a working key, which only confuses. The device's private keys themselves live in the Android Keystore and the iOS Keychain with "this device only" access (`@aparajita/capacitor-secure-storage`), so no backup carries them ([SECURITY.md](SECURITY.md)).
- **Icons and splash screens** come from `npm run native-assets`: one opaque 1024 px iOS icon (Xcode derives the rest), Android adaptive icons (foreground: the nanny on transparent, sized to stay inside the 66 dp safe circle; background: the logo's dark gradient as a vector in `res/drawable/ic_launcher_background.xml`) plus legacy and round icons for Android 7, and splash screens on the app's dark ground (`#0f1626`). Android 12+ shows the launcher icon on that ground; older versions use the layer list in `res/drawable/splash.xml`, which never stretches the logo. Themed (monochrome) Android icons are not there yet.

### Native push: Firebase files and the extension

Native push ([NOTIFICATIONS.md](NOTIFICATIONS.md#native-push)) needs two files from the Firebase project whose service account the relay uses. They are not in the repository (`.gitignore` lists them):

```
~/.config/kubernanny-store/
  google-services.json        Firebase, Android app app.kubernanny
  GoogleService-Info.plist    Firebase, iOS app app.kubernanny
```

`build_web` in the Fastfile copies them to `app/android/app/` and `app/ios/App/App/` before `cap sync`; without them the build goes on, says so, and that build has no push (the app hides the option). On Android the Gradle file applies the google-services plugin only when the file is there; on iOS a build phase copies the plist into the bundle only when it is there, and the plugin configures Firebase only then. For CI, store them as base64 secrets and write them to the same paths before the build.

Once, on a Mac: `cd app && bundle exec ruby scripts/add-push-extension.rb`. It adds the Notification Service Extension `KubernannyPushExtension` (bundle id `app.kubernanny.PushExtension`) to the Xcode project, embeds it, and gives the app and the extension the App Group `group.app.kubernanny.push` plus the app the Push Notifications capability. Register the App Group and enable Push Notifications for both identifiers in the developer account (automatic signing does it on the next build if the API key may). Then commit the changed `project.pbxproj` and the new `App/App.entitlements`. For FCM to reach iPhones, upload an APNs authentication key in the Firebase console (Project settings, Cloud Messaging).

What changes for the store forms: the app now talks to Google (Firebase Cloud Messaging) when someone switches push on, and the FCM token is a device identifier used only to deliver notifications. Review the App Privacy and Data safety answers below against Apple's and Google's current definitions before the first release with push; they were written for an app without it. The Firebase SDKs are added without Analytics (Android: analytics collection deactivated in the plugin's manifest). The export compliance answer does not change: push uses standard algorithms too (HPKE with X25519 and ChaCha20-Poly1305, [PROTOCOL.md](PROTOCOL.md#push-messages)).

**Background Modes (since the widget's status push).** The app receives the hourly silent status push for its widget as an APNs background push and opens it in `AppDelegate` ([NOTIFICATIONS.md](NOTIFICATIONS.md#the-home-screen-widget)). For that, `App/Info.plist` has `UIBackgroundModes` = `remote-notification` and the App target the Background Modes capability, both set by `scripts/add-push-extension.rb` (which also compiles the extension's push code into the App target). Background Modes needs no setting on the App ID in the developer account and no change to the provisioning profile; "Remote notifications" only works with Push Notifications, which `app.kubernanny` already has. App Review: background modes are checked against what the app does with them; if asked, this answers: "Kubernanny uses remote notifications only to receive a silent, end-to-end encrypted status update of the user's own Kubernetes cluster, about once an hour, when the user has placed a Kubernanny home-screen widget. The app decrypts it on the device, updates the widget's data and returns at once. No content is shown, no audio, location or other background work."

**The dead man's switch (the release that brings it).** Deploy in this order: the relay first (Node image or `wrangler deploy`; it then says `deadman: true` in Ready), then the agents, then the app. An agent before the relay simply deposits nothing; an app before the agent shows "needs a newer agent". Nothing new is needed in the store forms: the switch uses the same push token and the same sealed pushes. App Review sees a new switch in the push section, "Warn when the agent goes silent".

Check on a device: switch push on in a cluster's settings, send the test push with the app in the background and with the phone locked, and once from an agent with the app removed and reinstalled (a new token; the app registers it on start). For the dead man's switch: pick a grace of 10 minutes, scale the agent to zero (`kubectl -n kubernanny scale deploy/kubernanny --replicas 0`), wait the grace, check that the message arrives with your sign and the widget says "Agent not answering", scale back and check the "reachable again" push.

### Plain HTTP to agents, and why the stores should accept it

Agents are often reached as `http://` in a home network or VPN: a port-forward, a NodePort, a LAN host name without a certificate. That is safe because every call between app and agent is end-to-end encrypted and authenticated with Noise against the agent key pinned at pairing ([PROTOCOL.md](PROTOCOL.md), [COMMUNICATION.md](COMMUNICATION.md)); the transport only ever carries ciphertext. Fetching a key that is not pinned yet is refused over plain HTTP by the app itself (`transportAllowed`). The platforms block plain HTTP by default, so:

- **iOS**: `NSAppTransportSecurity` → `NSAllowsArbitraryLoadsInWebContent = true`. All of the app's requests come from the web view; the app has no native networking of its own. Not `NSAllowsLocalNetworking`: it only covers `.local` and unqualified names, not LAN DNS names or VPN names (e.g. Tailscale's). Not `NSAllowsArbitraryLoads`: iOS ignores it as soon as an `…InWebContent` key is present, and the web view exception is the narrower one. `NSLocalNetworkUsageDescription` (German, like the app) explains the local network prompt iOS shows before the first call into the LAN.
- **Android**: `res/xml/network_security_config.xml` permits cleartext, and `android.allowMixedContent: true` in `capacitor.config.ts` lets the WebView (whose page is `https://localhost`) call `http://` agents at all.

App Review asks for a justification of ATS exceptions. The review notes (`fastlane/review-notes.txt`) carry it; if asked again, this text answers:

> Kubernanny connects only to the user's own server (the Kubernanny agent in their Kubernetes cluster), which is often reachable only by plain HTTP inside a home network or VPN, where certificates are rare. Every request and response is end-to-end encrypted and authenticated with the Noise protocol: the device has its own key pair and the server's public key is pinned when the device is paired. The transport therefore only carries ciphertext, and the ATS exception (limited to the web view, which makes all of the app's requests) does not weaken confidentiality or integrity.

### Android: no required hardware features

A Capacitor plugin's manifest may declare `<uses-feature android:name="…"/>` without `android:required`, which defaults to `true`; the manifest merger carries it into the bundle, and Google Play then hides the app from every device without that hardware (and stops updates for people who have it installed). Today no plugin declares one (checked again with `@capacitor-mlkit/barcode-scanning`, which also adds no `CAMERA` permission). **After adding a plugin**, check the merged manifest:

```sh
cd app/android && ./gradlew :app:processReleaseMainManifest
grep -o '<uses-feature[^>]*>' app/build/intermediates/merged_manifest/release/processReleaseMainManifest/AndroidManifest.xml
```

Every line must carry `android:required="false"` unless the app cannot work without that hardware. To override a plugin, repeat its declaration in `app/android/app/src/main/AndroidManifest.xml` with `android:required="false" tools:replace="android:required"` (and `xmlns:tools="http://schemas.android.com/tools"` on `<manifest>`). `tools:replace` is needed because `android:required` otherwise merges with OR semantics, where one `true` wins.

### Widgets

The home-screen widgets ([ARCHITECTURE.md, Widgets](ARCHITECTURE.md#widgets)) have two native parts. The plugin that hands them their data, `app/native/widget-bridge` (npm `@kubernanny/widget-bridge`, a `file:` dependency of the app), is wired in by `npx cap sync` like any plugin, on both platforms. The rest:

- **Android**: nothing to do. The plugin's library carries both widgets (`ClusterWidgetProvider` for all clusters, `ClusterDetailWidgetProvider` for one, drawn by `WidgetRender` from the `kn_overview_*` / `kn_cluster_*` layouts, `kn_*` resources, English and German strings) and declares their receivers and the non-exported `WidgetRefreshReceiver` (redraws after a push, when a cluster turns grey, after an app update) in its own manifest, which the manifest merger adds to the app. It is written in Kotlin; the library applies the Kotlin Gradle plugin itself (Capacitor's default Kotlin version, 2.2.20, or `kotlin_version` from `variables.gradle` if set there). It declares no `<uses-feature>` and no permission: the grey-out alarm is an inexact, non-waking one.
- **iOS**: the widget is the app extension `KubernannyWidget` (bundle id `app.kubernanny.KubernannyWidget`, WidgetKit and SwiftUI, iOS 15.0 like the app: the all-clusters widget in small, medium, large and extra large, from iOS 16 also on the Lock Screen; from iOS 17 the one-cluster widget with "Choose cluster", an App Intent, so no intent definition file), with its sources in `app/ios/App/KubernannyWidget/`. The target is in the Xcode project and embedded in the app (Embed Foundation Extensions). It was added by `cd app && bundle exec ruby scripts/add-widget-extension.rb`, which is idempotent like `add-push-extension.rb`: run it again after adding a source file to the widget (it adds the files in its `SOURCES` list a target made earlier lacks) or if the project is ever regenerated. It gives the widget its entitlements file (`KubernannyWidget/KubernannyWidget.entitlements`, App Group `group.app.kubernanny`) and merges the same group into `App/App.entitlements`, next to `group.app.kubernanny.push` and `aps-environment`. The app's WidgetBridge plugin writes the clusters as one JSON string under `kubernanny.widget.clusters.v1` into that App Group's UserDefaults; the widget reads the same key (`WidgetData.swift`). Both must name the same group, or the widget stays empty. The push extension writes the state a push carries into the same group (`WidgetPushStatus.swift`), so `scripts/add-push-extension.rb` adds `group.app.kubernanny` to `KubernannyPushExtension.entitlements` too (and `WidgetPushStatus.swift` to that target).
- **Signing**: the release lane signs automatically with `-allowProvisioningUpdates`, so App Store profiles for `app.kubernanny`, `app.kubernanny.KubernannyWidget` and `app.kubernanny.PushExtension` are created with the App Group `group.app.kubernanny`. If the API key cannot assign the group, enable it under Certificates, Identifiers & Profiles → Identifiers on all three App IDs (the push extension's is new since the widget updates from pushes); then build again. Version and build number of the extension come from the same `MARKETING_VERSION` / `CURRENT_PROJECT_VERSION` the lane passes for the app, as App Store Connect requires them to match.
- **Store texts**: none needed; the widget gallery shows the widget's own name and description.

## One-time setup

Nothing account-specific is in the repository. Credentials and account values live in `~/.config/kubernanny-store/` (another place with `KUBERNANNY_STORE_DIR`), and the keystore password in the macOS keychain or the environment.

```
~/.config/kubernanny-store/
  asc-api-key.json            App Store Connect API key, fastlane format
  asc-api-key.p8              the same key as downloaded (xcodebuild needs the file)
  play-service-account.json   Google Play service account key
  upload-keystore.jks         Android upload key
  store.env                   the values below
```

`store.env` (read by the Fastfile; variables already set in the environment win):

```sh
KUBERNANNY_APPLE_TEAM_ID=XXXXXXXXXX        # developer.apple.com → Membership details
KUBERNANNY_UPLOAD_KEY_ALIAS=upload         # default "upload"
# KUBERNANNY_UPLOAD_KEYSTORE=/path/to.jks  # default: upload-keystore.jks next to this file
# KUBERNANNY_UPLOAD_KEYSTORE_PASSWORD=…    # Linux; on macOS use the keychain instead
KUBERNANNY_REVIEW_FIRST_NAME=…             # App Review contact (shown only to Apple)
KUBERNANNY_REVIEW_LAST_NAME=…
KUBERNANNY_REVIEW_PHONE=+49…
KUBERNANNY_REVIEW_EMAIL=…
```

Keep the folder private: `chmod 700 ~/.config/kubernanny-store && chmod 600 ~/.config/kubernanny-store/*`.

### Apple

1. **Apple Developer Program** membership (99 USD a year). Note the team id.
2. **App id**: automatic signing registers `app.kubernanny` on the first build. Or register it under Certificates, Identifiers & Profiles. Three identifiers, each with the App Groups capability: `app.kubernanny` (Push Notifications and App Groups, with both groups `group.app.kubernanny` and `group.app.kubernanny.push`), `app.kubernanny.PushExtension` (App Groups `group.app.kubernanny.push` and `group.app.kubernanny`) and `app.kubernanny.KubernannyWidget` (App Group `group.app.kubernanny`, [Widgets](#widgets)). Register both App Groups under Identifiers → App Groups. Automatic signing with `-allowProvisioningUpdates` registers missing identifiers and assigns groups when the API key may; otherwise do it by hand and build again.
3. **App Store Connect app record**: Apps → "+" → New App: platform iOS, name "Kubernanny", primary language German, bundle id `app.kubernanny`, any SKU (e.g. `kubernanny`). The API cannot create it.
4. **API key**: Users and Access → Integrations → App Store Connect API → Team Keys → "+", role **Admin**. With a lower role the export fails with a cloud signing permission error: only Admin keys may use Apple's cloud-managed distribution certificate, which saves you from managing certificates and profiles (and why there is no `Matchfile`). A key's role cannot be changed later. Download `AuthKey_<KEYID>.p8` (only possible once) and write both files:
   ```sh
   cp AuthKey_ABC123.p8 ~/.config/kubernanny-store/asc-api-key.p8
   jq -n --arg id ABC123 --arg iss <issuer-id> --rawfile key ~/.config/kubernanny-store/asc-api-key.p8 \
     '{key_id: $id, issuer_id: $iss, key: $key, in_house: false}' > ~/.config/kubernanny-store/asc-api-key.json
   ```
5. In App Store Connect, once (the API does not cover these):
   - **App Privacy**: privacy policy URL https://kubernanny.app/privacy, data collection "Data Not Collected" (no analytics, no crash reporting, no account; the app talks only to the user's own agent). The camera (QR scanner) does not change this: frames are decoded on the device and never stored or sent.
   - **Age rating**: every answer "None" (4+).
   - **Pricing**: free, all countries.
   - **Category** is in the metadata (Developer Tools, secondary Utilities).
   - **Encryption / export compliance**: see below.
6. **Internal testers**: TestFlight → Internal Testing → add yourself. Internal builds need no review.

### Google Play

1. **Play Console** developer account (25 USD once). Google requires identity verification; a personal account created after November 2023 must also run a closed test with a minimum number of testers for a minimum time before it may publish to production (12 testers for 14 days at the time of writing; check the current rule in the Play Console).
2. **Create the app**: name "Kubernanny", default language German, app, free. Turn on **Play App Signing** (default for new apps).
3. **Upload key** (Google holds the real signing key; this one only proves uploads come from you):
   ```sh
   keytool -genkeypair -v -keystore ~/.config/kubernanny-store/upload-keystore.jks \
     -alias upload -keyalg RSA -keysize 4096 -validity 10000
   security add-generic-password -s kubernanny-upload-keystore -a kubernanny -w   # macOS: asks for the password
   ```
   Back the keystore up somewhere safe. A lost upload key can be reset through Play support, but it takes days.
4. **First upload by hand**: fastlane's documentation asks for the first build of a new app to be uploaded in the Play Console, not through the API. Build once with `bundle exec fastlane android build` and upload the AAB in Play Console → Testing → Internal testing. Until the app is published for the first time, Play only accepts draft releases from the API: use `PLAY_RELEASE_STATUS=draft npm run release` (or `release:continue`) and roll the draft out in the console.
5. **Service account**: in Google Cloud, create a project (or reuse one), enable the "Google Play Android Developer API", create a service account and a JSON key for it, save it as `~/.config/kubernanny-store/play-service-account.json`. In the Play Console → Users and permissions → invite the service account's e-mail with access to this app: view app information, manage store presence, release to testing tracks and to production. Permissions can take a while to apply.
6. In the Play Console, once:
   - **Data safety**: no data collected, no data shared; data is encrypted in transit; no account, so no deletion request needed. The QR scanner changes nothing here: the app has no camera permission, Google's code scanner in Play services reads the code on the device and hands the app only the text.
   - **Privacy policy**: https://kubernanny.app/privacy
   - **App access**: "All or some functionality is restricted" with instructions: *The app connects to the user's own Kubernanny agent in their Kubernetes cluster; there is no account. To try it without a cluster, tap "Erst mal die Demo ansehen" on the start screen: it opens three built-in demo clusters with every screen of the app.*
   - **Ads**: no ads. **Content rating**: questionnaire, all "no". **Target audience**: 18+ (a tool for administrators). **News app**: no. **Government app**: no.
   - **Store settings**: category Tools.
7. **Internal testers**: Testing → Internal testing → testers → an e-mail list with yourself.

### Encryption (App Store export compliance)

The app implements end-to-end encryption itself (`Noise_IK_25519_ChaChaPoly_BLAKE2b` through the `@noble/*` libraries, [PROTOCOL.md](PROTOCOL.md)), so the answer to "Does your app use encryption?" is yes, and it is not only Apple's HTTPS. Whether it qualifies for an exemption (for example authentication and data protection only, or the publicly available open-source source code) and whether a self-classification report or other filing is needed is a legal question this page does not answer; check Apple's export compliance documentation and, if in doubt, ask. Until `ITSAppUsesNonExemptEncryption` is set in `Info.plist`, App Store Connect asks for every build, and a TestFlight build shows "Missing Compliance" until it is answered. Once the answer is settled, add the key (and an export compliance code, if Apple issues one) so builds go through without the question.

## Listing texts, review notes, screenshots

- **Texts**: `fastlane/metadata/ios/<locale>/` (name, subtitle, description, keywords, promotional text, URLs) and `fastlane/metadata/android/<locale>/` (title, short and full description), German and English, one file per field. Edit, then `npm run store:metadata`. Rules: no em or en dashes; nothing about other mobile platforms in the iOS texts (App Store guideline 2.3.10); keep keywords to generic terms (other projects' names belong in the description, not the keyword field); limits: name and subtitle 30, keywords 100, promotional text 170, Play short description 80, descriptions 4000 characters.
- **App Review notes**: `fastlane/review-notes.txt` (English). They say how to review without a cluster (the built-in demo) and justify the ATS exception. Keep the demo button's label there in step with the app. The contact comes from `store.env`; there is no demo account.
- **Screenshots**: `fastlane/screenshots/ios/<locale>/*.png` (deliver tells devices apart by pixel size) and `fastlane/screenshots/android/<locale>/images/phoneScreenshots/*.png` (and `tenInchScreenshots/` for tablets). The Play `icon.png` (512 px) and `featureGraphic.png` (1024 × 500) next to them come from `npm run native-assets`. The App Store needs the largest iPhone size (6.9", 1320 × 2868 or 1290 × 2796) and, because the app runs on iPad, the 13" iPad size (2064 × 2752 or 2048 × 2732); check App Store Connect for the current list. Play needs two to eight phone screenshots.
  - `npm run store:shots` (`scripts/store-screenshots/run.sh`) renders them: it starts the three demo agents of the documentation screenshots (`scripts/screenshots/demo-agents.sh`), pairs the web UI with them and takes eight screens (overview red with the eye, issues with cause and actions, a node's CPU and RAM with requests and limits, a restart with its OOMKill, the CloudNativePG sheet, the Argo CD apps ready to sync, the cluster list, the push settings with the sign picker) in English and German, dark, on a real device's viewport (`capture.cjs`, raw shots in `scripts/store-screenshots/raw/`). `frame/frame.cjs` then frames each shot like a store gallery: a short headline and subline (`frame/texts.cjs`) on the brand background (the website's navy with the mint, amber and coral lights, the app's fonts), the app inside a generic device drawn in CSS (`frame/template.html`: rounded body, island or punch hole, status bar and home indicator over the safe area the app was given; no real device images or trademarks), the device at the same height on every shot of a size, the first shot with the logo. Sizes and devices are in `targets.cjs`: iPhone 1320 × 2868 and iPad 2064 × 2752 into `ios/<locale>/` (`iphone69-*`, `ipad13-*`), Play phone 1080 × 1920 and ten-inch tablet 1600 × 2560 into `android/<locale>/images/phoneScreenshots/` and `tenInchScreenshots/` (iOS look and frame on the iOS sizes, Android's on Play's). A check at the end refuses any file at a wrong size or a folder with fewer than 6 or more than 8; files are RGB, no alpha. Look at every picture, then `npm run store:screenshots`.
  - Switches: `SKIP_BUILD=1` reuses the existing `dist/` of protocol, agent and app; `ONLY=iphone69,phone` renders only those sizes. Playwright comes from `e2e/node_modules` (`NODE_PATH`) unless installed elsewhere. To change only a headline or the frame, edit `frame/texts.cjs` or `frame/template.html` and run `NODE_PATH=e2e/node_modules node scripts/store-screenshots/frame/frame.cjs`, which re-frames the shots in `raw/` without the agents. Keep the headlines short, true, equivalent in both languages (German with "du") and free of em or en dashes; the renderer reports copy that runs off the canvas. The push screen exists only in the native app: the script gives the web build a stand-in for the push plugin (`pushPlugin`) and starts the demo agents with a relay address nothing listens on (`DEMO_RELAY_URL`), so the settings offer push.
  - The rendered files (about 50 MB) are **not committed** (`.gitignore`); render them before each upload. The Play icon and feature graphic stay committed.

## Check on a real device before the first submission

These could not be tested without devices and belong on the checklist of the first release:

- iOS: pairing with an `http://` agent in the LAN works (ATS exception, local network prompt), and with an `https://` one.
- Android: the same; Android 12+ and an Android 7 or 8 device or emulator (legacy icon, layer-list splash).
- A `kubernanny://pair?…` link from the camera opens the app and lands on the pairing page, on both platforms, from a cold start and with the app running.
- "QR-Code scannen" on a real iPhone: the camera prompt shows the German text, a pairing QR code lands on the pairing page, any other QR code shows "Das ist kein Pairing-Code von Kubernanny", denying the camera shows the hint to allow it in the settings. (Android was checked on the emulator with a virtual-scene poster: pairing link, other QR code, the full pairing against a demo agent.)
- The adaptive icon in a launcher with circle and squircle masks.
- Widget status push, both platforms (a phone with push on and a widget placed, app in the background, not swiped away): set `notifications.appPush.widgetRefreshMinutes: 30` on a test agent, wait 30 minutes without changes, and the widget's age resets without any notification (`kubernanny_widget_pushes_total{outcome="sent"}` on the agent counts it). Removing the widget and opening the app once stops them (the agent logs the registration without "with a widget").
- Widgets, both platforms: placing each kind (iOS small, medium, large, extra large on an iPad, the Lock Screen accessories, "Choose cluster"; Android both widgets at 2 × 1, 2 × 2, 4 × 2 and 4 × 4 cells), red, yellow and green clusters and a demo cluster, the largest text size; a tap on a cluster or a problem opens it, from a cold start and with the app running; after 2 hours without opening the app or a push the entries turn grey and say "Not current" and "Open Kubernanny" (check the 2 × 1 and small sizes); with push on and the app closed, a test push or a resolution updates the widget (iOS: also in the background on a locked phone); switching a cluster off in its settings and "Home-screen widgets: Off" on the cluster list empty the widget at once; German and English device language.
