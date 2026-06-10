# Mera — Privacy-First Personalized News

[![App Store](https://img.shields.io/badge/App%20Store-Download-0D96F6?logo=apple&logoColor=white)](https://apps.apple.com/nl/app/mera-news/id6754119677)
[![Google Play](https://img.shields.io/badge/Google%20Play-Download-414141?logo=googleplay&logoColor=white)](https://play.google.com/store/apps/details?id=com.mera.news)

[![License: Proprietary](https://img.shields.io/badge/License-Proprietary%20(All%20Rights%20Reserved)-red)](LICENSE.md)
[![Platform: iOS & Android](https://img.shields.io/badge/Platform-iOS%20%26%20Android-lightgrey)]()

## What is Mera?

Mera is a personalized news app for iOS and Android. It scores article relevance with an LLM that runs **either fully on-device** (Qwen3.5 4B via llama.rn) **or in a confidential cloud TEE** — a hardware-encrypted, attestation-verified enclave — with the inference path chosen per the user's settings. Both paths uphold the **Mera Protocol**: no personal data leaves the device in readable form, and inference is only ever performed locally or inside an encrypted environment. News is fetched and personalized in real time against the Mera backend. This software is proprietary and confidential — Copyright © 2025-2026 Mera Labs B.V. (KVK 42077437), all rights reserved. No license to use, copy, modify, or distribute it is granted except by separate written agreement with Mera Labs B.V.

## Architecture Overview

Mera is built on **Expo SDK 54 / React Native 0.81** with **React 19**. Key layers:

- **Apollo Client** (GraphQL, no-cache policy) fetches article suggestion IDs and content from a NestJS backend.
- **WatermelonDB** caches article suggestions locally for offline scoring and diffing.
- **Inference (on-device or confidential cloud)** — Relevance scoring, topic generation, and personalization reasons are produced by an LLM running either on-device (llama.rn running Qwen3.5 4B) or in a cloud TEE. The user chooses the path; the on-device path needs no network call.
- **Mera Protocol** — the privacy ruleset enforced across both paths: no personal data leaves the device in readable form, and inference is performed only locally or inside an attested, encrypted environment. An optional noise-injection mode adds decoy topics to further obfuscate intent.
- **E2EE cloud inference (TEE)** — when the cloud path is used, payloads are end-to-end encrypted (XChaCha20-Poly1305 + X25519 ECDH) to a NEAR AI Cloud v2 attestation-verified gateway, so inference runs inside a verified trusted execution environment that the operator cannot inspect. The gateway (`mera-inference-gateway`) is a proprietary Mera Labs service.
- **Better Auth** with email OTP handles authentication; tokens are stored in expo-secure-store.
- **BYO backend** — all three required service endpoints are configured via environment variables; no Mera infrastructure is required to run the app.

## Prerequisites

- **Node.js 20+**, npm 10+
- **Expo CLI**: `npm install -g expo-cli`
- **EAS CLI**: `npm install -g eas-cli`
- **iOS**: Xcode 16+, CocoaPods
- **Android**: Android Studio with SDK 34+
- A running backend that satisfies the Backend Requirements below

## Quick Start

1. **Clone and install:**
   ```bash
   git clone <your-fork-url> mera-app
   cd mera-app
   npm install
   ```

2. **Copy the env template and fill in your endpoints:**
   ```bash
   cp .env.example .env
   # Edit .env — the three EXPO_PUBLIC_* endpoint vars are required;
   # the app hard-crashes at launch if any are missing.
   ```

3. **Supply your Firebase `google-services.json`:**
   The file committed in this repo belongs to Mera Labs B.V. and will not work for your fork. Create a Firebase Android app in your own Firebase project, download its `google-services.json`, and place it at both the repo root and `android/app/google-services.json`. See `google-services.example.json` for the expected JSON shape.

4. **Start the dev server:**
   ```bash
   npx expo start
   ```

## Backend Requirements (BYO Backend)

You must supply your own backend. The app reads three required endpoint variables at launch from your `.env` (see `.env.example` for the full template):

| Variable | Description | Required |
|---|---|---|
| `EXPO_PUBLIC_AUTH_ENDPOINT` | Base URL of the Better Auth service. Must expose `/api/auth/` routes including OTP and JWKS (`/api/auth/jwks`). | Yes — hard crash if absent |
| `EXPO_PUBLIC_GRAPHQL_SERVER_ENDPOINT` | Base URL of the NestJS GraphQL API. Apollo appends `/graphql`. | Yes — hard crash if absent |
| `EXPO_PUBLIC_INFERENCE_ENDPOINT` | Base URL of the inference gateway. Must expose: `/v1/inference/jobs`, `/v1/chat/completions`, `/v1/chat/completions/batch`, `/api/attestation/report` (NEAR AI Cloud v2 attestation contract for E2EE cloud inference). | Yes — hard crash if absent |

> **The Mera backend services are proprietary and not published.** The inference gateway (`mera-inference-gateway`), the auth service, and the GraphQL API (`mera-server`) are proprietary Mera Labs services. `EXPO_PUBLIC_INFERENCE_ENDPOINT` must point at a Mera Labs deployment of the gateway that satisfies the contracts above.

Additionally, the following external service dependencies must be configured before the app is fully functional. See the Required-Config Inventory in `open-source-readiness/04-infra-coupling-and-config.md` for the complete variable and service table:

- **Expo / EAS project** — run `eas init` to bind to your own EAS project, or set `EXPO_OWNER`/`EAS_PROJECT_ID` in `.env`.
- **Firebase (Android push notifications)** — supply your own `google-services.json` matching your app package name.
- **iOS push notifications** — register your own bundle ID for push and regenerate `/ios` via `expo prebuild --clean`.
- **Google Play submit** — supply your own GCP service-account key at `google-play-service-account.json`.
- **Sentry (optional)** — set `EXPO_PUBLIC_SENTRY_DSN`, `SENTRY_ORG`, `SENTRY_PROJECT`, and `SENTRY_AUTH_TOKEN` in `.env`. The app runs without these; error reporting is a no-op.

**GraphQL schema:** `schema.gql` in this repo is a snapshot of the reference backend's schema and doubles as the contract your backend must satisfy. If your backend's schema diverges, export your server's `schema.gql` into the repo root, then run `npm run codegen` to regenerate `lib/generated/graphql-types.ts`.

## Configuring for Your Own Fork

Before distributing a fork publicly you must rebrand the app. `TRADEMARK.md` prohibits using the "Mera" name in any fork. The minimum required changes are:

- **App name, slug, and scheme** — set `APP_NAME`, `APP_SLUG`, `APP_SCHEME` in `.env` (via `app.config.js`) or edit `app.json` directly. The name must not contain "Mera".
- **Bundle ID / application ID** — set `APP_BUNDLE_ID` and `APP_PACKAGE` in `.env`, then run `npx expo prebuild --clean` to regenerate the native `/ios` and `/android` directories with your identifiers.
- **Privacy Policy and Terms of Service URLs** — set `EXPO_PUBLIC_PRIVACY_URL` and `EXPO_PUBLIC_TERMS_URL` in `.env`; these are centralized in `lib/config/branding.ts`.
- **Contact/support email** — set `EXPO_PUBLIC_SUPPORT_EMAIL` in `.env`; this replaces `contact@mera.news` in all 20 locale files and source components.
- **Firebase project** — supply your own `google-services.json` for your Android app package.

See `TRADEMARK.md` for the full trademark policy and `open-source-readiness/04-infra-coupling-and-config.md` for the complete Identity/Branding Replacements table.

After changing native identity variables, run:
```bash
npx expo prebuild --clean
```
This regenerates `/ios` and `/android` from your updated `app.json`/`app.config.js` — the single correct way to retarget all native copies of the bundle ID, name, scheme, and Sentry properties at once.

## Development

```bash
npm run lint              # ESLint
npm run codegen           # Regenerate GraphQL types from schema.gql
npm test                  # Jest unit tests
npm run test:coverage     # Jest with coverage thresholds (CI gate)
npx expo start            # Dev server
eas build --profile development   # EAS development build
```

EAS updates (OTA, JS/TS/styling/GraphQL changes only):
```bash
eas update --branch production --message "description"
```
Native builds are required for native dependency changes, SDK version bumps, `app.json` native config, or new native modules.

## License & Trademark

**This project is proprietary and confidential — not open source.** It is licensed under the proprietary terms in [LICENSE.md](LICENSE.md). Copyright © 2025-2026 Mera Labs B.V. (KVK 42077437), all rights reserved. No license to use, copy, modify, or distribute it is granted except by separate written agreement with Mera Labs B.V.

`"private": true` in `package.json` is intentional — it prevents accidental `npm publish`.

See [TRADEMARK.md](TRADEMARK.md) for trademark restrictions.

For licensing inquiries: legal@meranews.app
For security vulnerabilities: see [SECURITY.md](SECURITY.md)
