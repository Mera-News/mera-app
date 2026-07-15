# COMMANDS.md

Quick reference for the npm, Expo, and EAS commands used to develop, build, ship, and update **Mera** (`com.mera.news`).

> Project: EAS owner `perspient`, projectId `109fbed6-1099-4da9-bdb7-1e51363c1709`.
> Runtime version policy: `appVersion` (a native build is tied to the `version` in `app.json`).
> Build profiles & channels are defined in [eas.json](eas.json). App version currently `1.2.0`.

---

## 1. Local Development

```bash
npm install                  # Install dependencies (run after pulling / branch switch)
npm start                    # expo start — dev server, then press i / a / w
npm run ios                  # expo run:ios — build + run native iOS on simulator
npm run android              # expo run:android — build + run native Android on emulator
npm run web                  # expo start --web
```

Useful `expo start` flags:

```bash
npx expo start -c            # Clear Metro cache (fixes stale bundle / module-resolver issues)
npx expo start --tunnel      # Tunnel mode (test on a physical device off your LAN)
npx expo start --dev-client  # Start against a custom dev client build (not Expo Go)
```

## 2. Code Quality & Codegen

```bash
npm run lint                 # expo lint (ESLint)
npm run format               # prettier --write .
npm run format:check         # prettier --check .
npm run codegen              # GraphQL codegen: schema.gql → lib/generated/graphql-types.ts
npm run codegen:watch        # Codegen in watch mode
npm test                     # Jest
npm run test:watch           # Jest watch
npm run test:coverage        # Jest with coverage
```

> Always re-run `npm run codegen` after any change to `schema.gql`.

## 3. Diagnostics

```bash
npx expo-doctor              # Check for dependency / config issues
npx expo install --check     # Verify installed native deps match the SDK
npx expo install --fix       # Bump native deps to SDK-compatible versions
npx expo config --type public  # Print the resolved app config (owner, projectId, plugins)
npx expo prebuild --clean    # Regenerate native ios/ + android/ dirs from config
```

## 4. EAS Auth & Setup

```bash
npm i -g eas-cli             # Install / update the EAS CLI globally
eas login                    # Log in to the perspient EAS account
eas whoami                   # Confirm the logged-in account
eas build:list               # Recent builds
eas build:configure          # (Re)generate eas.json if needed
```

---

## 5. EAS Build

Profiles come from [eas.json](eas.json): `development`, `development-simulator`, `preview`, `production`.

### Development (custom dev client, internal distribution)

```bash
# Device builds (Android = APK, iOS = device .ipa for dev client)
eas build --profile development --platform android
eas build --profile development --platform ios
eas build --profile development --platform all

# iOS Simulator build (runs in the simulator, no device provisioning)
eas build --profile development-simulator --platform ios
```

### Preview (internal distribution, `preview` channel)

```bash
eas build --profile preview --platform android
eas build --profile preview --platform ios
eas build --profile preview --platform all
```

### Production (store builds, auto-increments build number, `production` channel)

```bash
eas build --profile production --platform android
eas build --profile production --platform ios
eas build --profile production --platform all
```

Handy build flags:

```bash
--local                      # Build on your machine instead of EAS servers
--no-wait                    # Kick off the build and return immediately
--clear-cache                # Clear the remote build cache
--message "note"             # Attach a note to the build
```

## 6. Install a Build on Devices

- **Internal distribution** (development / preview): after the build finishes, EAS prints a QR code / install URL. Open it on the device to install, or:

```bash
eas build:list                        # Find the build
eas build:view <BUILD_ID>             # Get the install URL / details
```

- **Android APK**: download the `.apk` from the build page and install directly, or:

```bash
adb install path/to/app.apk           # Sideload onto a connected Android device/emulator
```

- **iOS Simulator build**: download the `.tar.gz`, unzip, then drag the `.app` onto the simulator or:

```bash
xcrun simctl install booted path/to/Mera.app
```

## 7. EAS Submit (to the stores)

`eas.json` defines the `production` submit profile (Android → Play Console **internal** track, using the Google service account key stored in EAS credentials).

```bash
# Submit the latest production build
eas submit --profile production --platform android
eas submit --profile production --platform ios
eas submit --profile production --platform all

# Submit a specific build
eas submit --platform ios --id <BUILD_ID>

# Build + submit in one step
eas build --profile production --platform ios --auto-submit
```

> iOS: first submit will prompt for Apple credentials / App Store Connect app selection.
> Android: uploads to the `internal` track — promote to production from the Play Console.

## 8. OTA Updates (`eas update`)

OTA works for **JS/TS, styling, and GraphQL** changes only. A **new native build is required** for: native deps, SDK bumps, `app.json` native config, new native modules, or a `version` change (runtime version is `appVersion`).

Channels map to profiles: `development`, `preview`, `production`.

```bash
# Publish an update to a channel's branch
eas update --channel production  --message "Fix feed scoring edge case"
eas update --channel preview     --message "QA: onboarding copy tweak"
eas update --channel development  --message "WIP"

# Auto-fill the message from the latest git commit
eas update --channel production --auto

# Inspect / manage updates
eas update:list --branch production
eas update:view <UPDATE_GROUP_ID>
eas channel:list
eas branch:list
```

> Because runtime version = `appVersion` (`1.2.0`), an OTA update is only delivered to installs whose native build has the **same** app version. After bumping `version` in `app.json`, ship a new native build before OTA updates reach it.

**Source maps for OTA updates:** `eas update` does not upload source maps on its own (only the native build phases do, via Xcode/Gradle), so JS stack traces from OTA bundles arrive at Sentry unsymbolicated and get mis-grouped. Use the `npm run update:*` scripts instead of a bare `eas update` — they chain `eas update --channel <channel>` with `npx sentry-expo-upload-sourcemaps dist` (the `dist/` dir is what `eas update` writes its bundle + source maps to), so every OTA publish stays symbolicated in Sentry:

```bash
npm run update:development   # eas update --channel development + sourcemap upload
npm run update:preview       # eas update --channel preview + sourcemap upload
npm run update:production    # eas update --channel production + sourcemap upload
```

Requires `SENTRY_ORG`, `SENTRY_PROJECT`, and `SENTRY_AUTH_TOKEN` to be set (see README's Backend Requirements table).

## 9. Version Bump Checklist (new store release)

1. Bump `version` in [app.json](app.json) (e.g. `1.2.0` → `1.3.0`).
2. `eas build --profile production --platform all` (build number auto-increments).
3. `eas submit --profile production --platform all` (or use `--auto-submit` in step 2).
4. After release, OTA patches for that version: `eas update --channel production --message "..."`.
