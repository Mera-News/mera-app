# Mera: Privacy-First Personalized News

[![App Store](https://img.shields.io/badge/App%20Store-Download-0D96F6?logo=apple&logoColor=white)](https://apps.apple.com/nl/app/mera-news/id6754119677)
[![Google Play](https://img.shields.io/badge/Google%20Play-Download-414141?logo=googleplay&logoColor=white)](https://play.google.com/store/apps/details?id=com.mera.news)

[![License: Source-Available](https://img.shields.io/badge/License-Source--Available%20(not%20open%20source)-orange)](LICENSE.md)
[![Platform: iOS & Android](https://img.shields.io/badge/Platform-iOS%20%26%20Android-lightgrey)]()

## What is Mera?

Mera is a personalized news app for iOS and Android. It scores article relevance with an LLM that runs **either fully on-device or in a confidential cloud TEE**, with the inference path chosen per the user's settings. Both paths uphold the **Mera Protocol**: your profile and reading history stay on the device, and inference is only ever performed locally or inside an encrypted environment. News is fetched and personalized in real time against the Mera backend.

This repository is **source-available, not open source**, published under the [Mera Source-Available License](LICENSE.md), which grants the right to read, compile, and run the software for study, security review, and evaluation, and does not grant production or commercial use. Copyright © 2025-2026 Mera Labs B.V. (KVK 42077437).

> **Most of the app's logic and the news side of the backend are public.** The app's non-UI logic lives in [`mera-news-client`](https://github.com/Mera-News/mera-news-client), and the news server in [`mera-news-data-server`](https://github.com/Mera-News/mera-news-data-server), both source-available under PolyForm Shield 1.0.0. Anyone can run the news side themselves. Sign-in, accounts, billing and notifications stay private. See [What is public and what is private](#what-is-public-and-what-is-private).

## Architecture Overview

Mera is built on **Expo SDK 58 / React Native 0.88** with **React 19**. Key layers:

- **Apollo Client** (GraphQL, no-cache policy) fetches article suggestion IDs and content from a NestJS backend.
- **WatermelonDB** caches article suggestions locally for offline scoring and diffing.
- **Inference (on-device or confidential cloud)**: Relevance scoring, topic generation, and personalization reasons are produced by an LLM running either on-device or in a cloud TEE. The user chooses the path; the on-device path needs no network call.
- **Mera Protocol**: personal data stays on the device, and inference is performed only locally or inside an encrypted environment. What leaves the device for news is the real topic phrases. They travel with your session, because the server checks your plan and counts the day's reading, so the server sees your account and your topics together while it answers. No stored record links an account to a topic. There is no decoy or padding layer, so nothing hides the topic list from Mera's server.
- **E2EE cloud inference (TEE)**: when the cloud path is used, payloads are end-to-end encrypted (XChaCha20-Poly1305 + X25519 ECDH) to a NEAR AI Cloud v2 gateway, so inference runs inside a trusted execution environment the operator cannot inspect. The client fetches the enclave's attestation report from `/api/attestation/report` and encrypts to the signing key it publishes.

  **Quote verification (`lib/algorithms/attestation-verify.ts`)**: the client parses the Intel TDX quote and verifies, in pure JS (no WebCrypto, no native modules, so it ships over the air): the quote signature, the quoting-enclave report signature, the attestation-key binding, and the PCK certificate chain up to a **pinned** Intel SGX Root CA hash. Critically it also checks that the `signing_public_key` the app encrypts toward is the key committed in the quote's `report_data`; without that check a genuine quote served alongside a substituted key would pass, which defeats the purpose. Every cloud call runs this check without a nonce. The Verify attestation screen adds a client-generated nonce that NEAR echoes into `report_data`, which proves that report is fresh. The same check follows NEAR's deployment log (`lib/algorithms/deployed-software.ts`) to the compose file that pins the proxy image, which shows the image NEAR says it installed, not what that software does. Users can run all of this from Settings → Mera Protocol → Verify attestation.

  **What blocks and what does not.** Before the app encrypts anything, it checks that the quote chains to the pinned Intel root and commits the key it is about to use. If that fails, the key is refused: nothing is encrypted to it or sent, and the request moves to the next model or fails. No setting turns this off. It covers cloud chat, scoring jobs and batch calls.

  ⚠️ **Not enforced, stated plainly:** freshness on normal calls (a nonce is used only on the Verify attestation screen), platform TCB currency and QE identity (that needs Intel PCS collateral the app does not fetch), enclave measurements against published values (none are published), and that the GPUs belong to the enclave. NVIDIA's signed GPU result is read only on the Verify attestation tap, and it does **not** show those GPUs are attached to the enclave. The check proves a genuine Intel TDX machine holds the key, not which software it runs, so do not describe this path as "hardware-proven". The Mera gateway only relays: it does not itself run in a TEE and refuses no request over attestation.

  **Not end-to-end encrypted:** web search and fact-check search. The query text goes to Mera's server over a normal secure connection.
- **Better Auth** handles accounts. You sign in with the phone itself (App Attest on iOS, Play Integrity on Android). There is no email, password, Apple or Google sign-in: each account is anonymous, with a placeholder address the server makes up. The server refuses to create an account with, or add, a real address, and Mera holds no email addresses. On Android the server stores only a keyed hash of the device id. Session tokens are kept in expo-secure-store. Google sign-in is used only to connect Google Drive for backups.
- **Configurable backend**: all three service endpoints are set via environment variables, so the app can be pointed at any backend satisfying the contracts below. Note the caveat in [Backend Requirements](#backend-requirements-byo-backend): the auth and GraphQL endpoints need a Mera Labs deployment or your own implementation, because those services are private.
- **`mera-inference-gateway`**: the E2EE inference relay, published as [`mera-inference-gateway`](https://github.com/Mera-News/mera-inference-gateway), source-available under PolyForm Shield 1.0.0.

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
   # Edit .env: the three EXPO_PUBLIC_* endpoint vars are required;
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
| `EXPO_PUBLIC_AUTH_ENDPOINT` | Base URL of the Better Auth service. Must expose `/api/auth/` routes including the device sign-in routes and JWKS (`/api/auth/jwks`). | Yes: hard crash if absent |
| `EXPO_PUBLIC_GRAPHQL_SERVER_ENDPOINT` | Base URL of the NestJS GraphQL API. Apollo appends `/graphql`. | Yes: hard crash if absent |
| `EXPO_PUBLIC_INFERENCE_ENDPOINT` | Base URL of the inference gateway. Must expose: `/v1/inference/jobs`, `/v1/chat/completions`, `/v1/chat/completions/batch`, `/api/attestation/report` (NEAR AI Cloud v2 attestation contract for E2EE cloud inference). | Yes: hard crash if absent |

> **Backend availability, as of today.** The inference relay (`mera-inference-gateway`) and the news
> server (`mera-news-data-server`) are published, so you can read, build and run them yourself. The
> auth service and the app's GraphQL API are **private**: `EXPO_PUBLIC_AUTH_ENDPOINT` and
> `EXPO_PUBLIC_GRAPHQL_SERVER_ENDPOINT` need a Mera Labs deployment or your own implementation of the
> contracts above. See [What is public and what is private](#what-is-public-and-what-is-private).

Additionally, the following external service dependencies must be configured before the app is fully functional:

- **Expo / EAS project**: run `eas init` to bind to your own EAS project, or set `EXPO_OWNER`/`EAS_PROJECT_ID` in `.env`.
- **Firebase (Android push notifications)**: supply your own `google-services.json` matching your app package name.
- **iOS push notifications**: register your own bundle ID for push and regenerate `/ios` via `expo prebuild --clean`.
- **Google Play submit**: upload your own GCP service-account key to EAS (project credentials → Android → "Google service account key for EAS Submit"). Alternatively, keep a local key file and point `submit.production.android.serviceAccountKeyPath` at it in `eas.json`.
- **Sentry (optional)**: set `EXPO_PUBLIC_SENTRY_DSN`, `SENTRY_ORG`, `SENTRY_PROJECT`, and `SENTRY_AUTH_TOKEN` in `.env`. The app runs without these; error reporting is a no-op.

**GraphQL schema:** `schema.gql` in this repo is a snapshot of the reference backend's schema and doubles as the contract your backend must satisfy. If your backend's schema diverges, export your server's `schema.gql` into the repo root, then run `npm run codegen` to regenerate `lib/generated/graphql-types.ts`.

## Configuring for Your Own Fork

Before distributing a fork publicly you must rebrand the app. `TRADEMARK.md` prohibits using the "Mera" name in any fork. The minimum required changes are:

- **App name, slug, and scheme**: set `APP_NAME`, `APP_SLUG`, `APP_SCHEME` in `.env` (via `app.config.js`) or edit `app.json` directly. The name must not contain "Mera".
- **Bundle ID / application ID**: set `APP_BUNDLE_ID` and `APP_PACKAGE` in `.env`, then run `npx expo prebuild --clean` to regenerate the native `/ios` and `/android` directories with your identifiers.
- **Privacy Policy and Terms of Service URLs**: set `EXPO_PUBLIC_PRIVACY_URL` and `EXPO_PUBLIC_TERMS_URL` in `.env`; these are centralized in `lib/config/branding.ts`.
- **Contact/support email**: set `EXPO_PUBLIC_SUPPORT_EMAIL` in `.env`; this replaces `contact@mera.news` in all 20 locale files and source components.
- **Firebase project**: supply your own `google-services.json` for your Android app package.

See [TRADEMARK.md](TRADEMARK.md) for the full trademark policy, and `.env.example` for the complete list of configurable identity and endpoint variables.

After changing native identity variables, run:
```bash
npx expo prebuild --clean
```
This regenerates `/ios` and `/android` from your updated `app.json`/`app.config.js`: the single correct way to retarget all native copies of the bundle ID, name, scheme, and Sentry properties at once.

## Development

All day-to-day commands (npm scripts, Expo, EAS build/submit, device install, and OTA updates) live in [COMMANDS.md](COMMANDS.md).

Before contributing, read [CONTRIBUTING.md](CONTRIBUTING.md) for the versioning, dependency, and testing rules.

OTA updates apply to JS/TS/styling/GraphQL changes only. Native builds are required for native dependency changes, SDK version bumps, `app.json` native config, or new native modules.

The AI logic that builds the personalized feed (topic generation, relevance scoring, and the chat agents) lives in `lib/news-harness/`, a React Native-free, ports-and-adapters module that the app runs in production and that can also be exercised standalone from the command line via `harness-local/`. To understand or iterate on feed quality (prompts, scoring, topic generation), see [NEWS_HARNESS.md](NEWS_HARNESS.md).

## What is public and what is private

Publishing the client shows what the app *sends*. The news side of the backend is public too, so you
can also read how news is fetched and served. The parts that know who you are stay private.

**Public, source-available under PolyForm Shield 1.0.0** (free to self-host, not open source):

| Repository | What it is |
|---|---|
| [`mera-news-client`](https://github.com/Mera-News/mera-news-client) | The app's non-UI logic: database, stores, scheduler, scoring, chat, encryption |
| [`mera-news-data-server`](https://github.com/Mera-News/mera-news-data-server) | The news server: ingest worker and news API |
| [`mera-news-pod`](https://github.com/Mera-News/mera-news-pod) and [`mera-news-pod-plugins`](https://github.com/Mera-News/mera-news-pod-plugins) | A self-hosted host that runs the client for one person |
| [`mera-inference-gateway`](https://github.com/Mera-News/mera-inference-gateway) | The encrypted inference relay |

This repository is source-available under its own licence (see below).

**Private:** sign-in, the app's GraphQL API that wraps the news server, billing, push notifications,
account purge and the admin board. Mera's production runs the public news server's code inside these
private services: ingest inside Mera's worker, retrieval inside the app API.

**Self-hosting.** Anyone can run the news side themselves, as Mera News Self-Hosted on the Mera News
Engine. The Mera News app cannot connect to a self-run server today.

**What no database stores:** a link between an account and a topic. Topics are stored by their text
alone, with no owner field, and a test scans every collection for such a link. While a news request is
being answered, the server does see your account and your topics together (see Known gaps). Request
bodies are not logged.

### Known gaps

Stated here rather than omitted:

- **Your topics are not masked.** The real topic phrases are sent; there is no decoy or padding layer.
- **Identity travels with topics.** Each news request carries your session, because the server checks
  your plan and counts the day's reading. Platform logs keep the path, status and IP address of failed
  requests for 30 days.
- **Attestation proves the key, not the software.** The quote check blocks, but freshness on normal
  calls, TCB currency, enclave measurements and GPU binding are not enforced (see Architecture
  Overview).
- **No reproducible builds.** [RELEASES.md](RELEASES.md) lists each over-the-air update with its
  commit and the SHA-256 of its bundles, so you can check that your phone runs what Mera published.
  The build is not reproducible, so that cannot prove the bundle was built from the commit, and the
  store binary has no published hash. Mera's servers publish no signed image, digest or deployed
  commit yet.
- **Source code cannot prove which code a server runs.** This is true of every service that publishes a
  backend: its guarantee has to come from the protocol, not from the server source.
- **Some records have no time limit.** Deleting an account signs it out on every device at once and
  removes its device keys and push token, and nothing can cancel it; after 30 days its profile
  settings, feedback, unblock requests, daily usage, sessions and sign-in links are deleted. An
  anonymised stub of the account and the billing record are kept with no time limit. Other periods:
  raw payment events from the billing provider 180 days, sessions 1 year, daily article counts 90
  days, feedback 365 days, unblock-request
  transcripts 90 or 180 days, the email log 30 days, the push log 14 days (with no account id). On the
  phone, deletion wipes the database, stores, keychain and files; backups already in your own iCloud or
  Google Drive stay there.
- **Prompt-injection hardening** in AI-processed content is ongoing.

## License & Trademark

**Source-available, not open source.** This repository is published under the
[Mera Source-Available License](LICENSE.md), which grants a worldwide, royalty-free, revocable licence to
access, read, download, compile, and run the software **for personal study, security review, auditing,
and evaluation**. It does **not** grant production, commercial, or competing use. "Open source" has a
specific meaning (an OSI-approved licence with the freedom to use and redistribute) and this licence
does not meet it; see `LICENSE.md` for the exact grant and restrictions.

Copyright © 2025-2026 Mera Labs B.V. (KVK 42077437). Rights not expressly granted are reserved.

`"private": true` in `package.json` is intentional: it prevents accidental `npm publish`.

See [TRADEMARK.md](TRADEMARK.md) for trademark restrictions.

For licensing inquiries: contact@mera.news
For security vulnerabilities: see [SECURITY.md](SECURITY.md)
