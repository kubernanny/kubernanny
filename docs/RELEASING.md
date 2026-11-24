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
- **Pairing links** `kubernanny://pair?url=…&code=…&key=…` (the agent's QR code): `CFBundleURLTypes` in `Info.plist`, an intent filter for scheme `kubernanny` and host `pair` in the manifest. The app handles them in `app/src/app/app.ts` (`pairingRoute`).
- **Backups off on Android** (`allowBackup="false"`, `res/xml/data_extraction_rules.xml`): a restored backup would bring the cluster list onto another phone without a working key, which only confuses. The device's private keys themselves live in the Android Keystore and the iOS Keychain with "this device only" access (`@aparajita/capacitor-secure-storage`), so no backup carries them ([SECURITY.md](SECURITY.md)).
- **Icons and splash screens** come from `npm run native-assets`: one opaque 1024 px iOS icon (Xcode derives the rest), Android adaptive icons (foreground: the nanny on transparent, sized to stay inside the 66 dp safe circle; background: the logo's dark gradient as a vector in `res/drawable/ic_launcher_background.xml`) plus legacy and round icons for Android 7, and splash screens on the app's dark ground (`#0f1626`). Android 12+ shows the launcher icon on that ground; older versions use the layer list in `res/drawable/splash.xml`, which never stretches the logo. Themed (monochrome) Android icons are not there yet.

### Plain HTTP to agents, and why the stores should accept it

Agents are often reached as `http://` in a home network or VPN: a port-forward, a NodePort, a LAN host name without a certificate. That is safe because every call between app and agent is end-to-end encrypted and authenticated with Noise against the agent key pinned at pairing ([PROTOCOL.md](PROTOCOL.md), [COMMUNICATION.md](COMMUNICATION.md)); the transport only ever carries ciphertext. Fetching a key that is not pinned yet is refused over plain HTTP by the app itself (`transportAllowed`). The platforms block plain HTTP by default, so:

- **iOS**: `NSAppTransportSecurity` → `NSAllowsArbitraryLoadsInWebContent = true`. All of the app's requests come from the web view; the app has no native networking of its own. Not `NSAllowsLocalNetworking`: it only covers `.local` and unqualified names, not LAN DNS names or VPN names (e.g. Tailscale's). Not `NSAllowsArbitraryLoads`: iOS ignores it as soon as an `…InWebContent` key is present, and the web view exception is the narrower one. `NSLocalNetworkUsageDescription` (German, like the app) explains the local network prompt iOS shows before the first call into the LAN.
- **Android**: `res/xml/network_security_config.xml` permits cleartext, and `android.allowMixedContent: true` in `capacitor.config.ts` lets the WebView (whose page is `https://localhost`) call `http://` agents at all.

App Review asks for a justification of ATS exceptions. The review notes (`fastlane/review-notes.txt`) carry it; if asked again, this text answers:

> Kubernanny connects only to the user's own server (the Kubernanny agent in their Kubernetes cluster), which is often reachable only by plain HTTP inside a home network or VPN, where certificates are rare. Every request and response is end-to-end encrypted and authenticated with the Noise protocol: the device has its own key pair and the server's public key is pinned when the device is paired. The transport therefore only carries ciphertext, and the ATS exception (limited to the web view, which makes all of the app's requests) does not weaken confidentiality or integrity.

### Android: no required hardware features

A Capacitor plugin's manifest may declare `<uses-feature android:name="…"/>` without `android:required`, which defaults to `true`; the manifest merger carries it into the bundle, and Google Play then hides the app from every device without that hardware (and stops updates for people who have it installed). Today no plugin declares one (`@capacitor/app`, `@capacitor/preferences`). **After adding a plugin**, check the merged manifest:

```sh
cd app/android && ./gradlew :app:processReleaseMainManifest
grep -o '<uses-feature[^>]*>' app/build/intermediates/merged_manifest/release/processReleaseMainManifest/AndroidManifest.xml
```

Every line must carry `android:required="false"` unless the app cannot work without that hardware. To override a plugin, repeat its declaration in `app/android/app/src/main/AndroidManifest.xml` with `android:required="false" tools:replace="android:required"` (and `xmlns:tools="http://schemas.android.com/tools"` on `<manifest>`). `tools:replace` is needed because `android:required` otherwise merges with OR semantics, where one `true` wins.

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
2. **App id**: automatic signing registers `app.kubernanny` on the first build. Or register it under Certificates, Identifiers & Profiles; no capabilities are needed.
3. **App Store Connect app record**: Apps → "+" → New App: platform iOS, name "Kubernanny", primary language German, bundle id `app.kubernanny`, any SKU (e.g. `kubernanny`). The API cannot create it.
4. **API key**: Users and Access → Integrations → App Store Connect API → Team Keys → "+", role **Admin**. With a lower role the export fails with a cloud signing permission error: only Admin keys may use Apple's cloud-managed distribution certificate, which saves you from managing certificates and profiles (and why there is no `Matchfile`). A key's role cannot be changed later. Download `AuthKey_<KEYID>.p8` (only possible once) and write both files:
   ```sh
   cp AuthKey_ABC123.p8 ~/.config/kubernanny-store/asc-api-key.p8
   jq -n --arg id ABC123 --arg iss <issuer-id> --rawfile key ~/.config/kubernanny-store/asc-api-key.p8 \
     '{key_id: $id, issuer_id: $iss, key: $key, in_house: false}' > ~/.config/kubernanny-store/asc-api-key.json
   ```
5. In App Store Connect, once (the API does not cover these):
   - **App Privacy**: privacy policy URL https://kubernanny.app/privacy, data collection "Data Not Collected" (no analytics, no crash reporting, no account; the app talks only to the user's own agent).
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
   - **Data safety**: no data collected, no data shared; data is encrypted in transit; no account, so no deletion request needed.
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
- **Screenshots**: `fastlane/screenshots/ios/<locale>/*.png` (deliver tells devices apart by pixel size) and `fastlane/screenshots/android/<locale>/images/phoneScreenshots/*.png` (and `tenInchScreenshots/` for tablets). The Play `icon.png` (512 px) and `featureGraphic.png` (1024 × 500) next to them come from `npm run native-assets`. The App Store needs the largest iPhone size (6.9", 1320 × 2868 or 1290 × 2796) and, because the app runs on iPad, the 13" iPad size (2064 × 2752 or 2048 × 2732); check App Store Connect for the current list. Play needs two to eight phone screenshots. The documentation screenshots (`scripts/screenshots/`) are taken at other sizes; render store sizes from the demo clusters the same way (an iPhone viewport at the right scale factor), there is no script for it yet.

## Check on a real device before the first submission

These could not be tested without devices and belong on the checklist of the first release:

- iOS: pairing with an `http://` agent in the LAN works (ATS exception, local network prompt), and with an `https://` one.
- Android: the same; Android 12+ and an Android 7 or 8 device or emulator (legacy icon, layer-list splash).
- A `kubernanny://pair?…` link from the camera opens the app and lands on the pairing page, on both platforms, from a cold start and with the app running.
- The adaptive icon in a launcher with circle and squircle masks.
