# Mera: Privacy-First Personalized News

[![App Store](https://img.shields.io/badge/App%20Store-Download-0D96F6?logo=apple&logoColor=white)](https://apps.apple.com/nl/app/mera-news/id6754119677)
[![Google Play](https://img.shields.io/badge/Google%20Play-Download-414141?logo=googleplay&logoColor=white)](https://play.google.com/store/apps/details?id=com.mera.news)

[![License: Source-Available](https://img.shields.io/badge/License-Source--Available%20(not%20open%20source)-orange)](LICENSE.md)
[![Platform: iOS & Android](https://img.shields.io/badge/Platform-iOS%20%26%20Android-lightgrey)]()

## What is Mera?

Mera is a personalized news app for iOS and Android. It scores article relevance with an LLM that runs **either fully on-device** (Qwen3.5 4B via llama.rn) **or in a confidential cloud TEE**, with the inference path chosen per the user's settings. Both paths uphold the **Mera Protocol**: no personal data leaves the device in readable form, and inference is only ever performed locally or inside an encrypted environment. News is fetched and personalized in real time against the Mera backend.

This repository is **source-available, not open source**, published under the [Mera Source-Available License](LICENSE.md), which grants the right to read, compile, and run the software for study, security review, and evaluation, and does not grant production or commercial use. Copyright © 2025-2026 Mera Labs B.V. (KVK 42077437).

> **The backend is being made source-available too (target: before September 2026).** Today you can verify what the app *sends*; you cannot yet read what happens next. That gap is being closed. See [Backend source-availability](#backend-source-availability-in-progress) for the architecture, what opens, and what stays closed.

## Architecture Overview

Mera is built on **Expo SDK 54 / React Native 0.81** with **React 19**. Key layers:

- **Apollo Client** (GraphQL, no-cache policy) fetches article suggestion IDs and content from a NestJS backend.
- **WatermelonDB** caches article suggestions locally for offline scoring and diffing.
- **Inference (on-device or confidential cloud)**: Relevance scoring, topic generation, and personalization reasons are produced by an LLM running either on-device (llama.rn running Qwen3.5 4B) or in a cloud TEE. The user chooses the path; the on-device path needs no network call.
- **Mera Protocol**: the privacy ruleset enforced across both paths: no personal data leaves the device in readable form, and inference is performed only locally or inside an encrypted environment. What leaves the device is the real topic phrases, carrying no user identifier; the decoy / noise-injection layer (Protocol Rules 2, 3 and 5) is **in development and does not ship today**, so nothing currently pads the outbound topic list.
- **E2EE cloud inference (TEE)**: when the cloud path is used, payloads are end-to-end encrypted (XChaCha20-Poly1305 + X25519 ECDH) to a NEAR AI Cloud v2 gateway, so inference runs inside a trusted execution environment the operator cannot inspect. The client fetches the enclave's attestation report from `/api/attestation/report` and encrypts to the signing key it publishes.

  **Quote verification (`lib/e2ee/attestation-verify.ts`)**: the client parses the Intel TDX quote and verifies, in pure JS (no WebCrypto, no native modules, so it ships over the air) — the quote signature, the quoting-enclave report signature, the attestation-key binding, and the PCK certificate chain up to a **pinned** Intel SGX Root CA hash. Critically it also checks that the `signing_public_key` the app encrypts toward is the key committed in the quote's `report_data`; without that check a genuine quote served alongside a substituted key would pass, which defeats the purpose. Freshness is proven with a client-generated nonce that NEAR echoes into `report_data`. Users can run all of this from Settings → Mera Protocol → Verify attestation.

  ⚠️ **Remaining gaps, stated plainly:** platform TCB currency and QE identity are **not** checked (that needs Intel PCS collateral the app does not fetch), enclave measurements are **not** compared against published expected values, and the NVIDIA GPU attestation (`nvidia_payload`) is **not** verified. Verification is also **fail-open**: results are displayed but a failure does not block inference, because there are no published expected measurements to pin against yet and a collateral hiccup would otherwise brick cloud mode. So do not describe this path as "hardware-proven". Fail-closed enforcement is planned once field data shows the pass rate is stable.
- **Better Auth** with email OTP handles authentication; tokens are stored in expo-secure-store.
- **Configurable backend**: all three service endpoints are set via environment variables, so the app can be pointed at any backend satisfying the contracts below. Note the caveat in [Backend Requirements](#backend-requirements-byo-backend): the inference endpoint currently still requires a Mera Labs deployment. Removing that dependency is part of the backend source-availability work.
- **`mera-inference-gateway`**: the E2EE inference relay, already published at [github.com/Mera-News](https://github.com/Mera-News) under the same source-available terms.

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
| `EXPO_PUBLIC_AUTH_ENDPOINT` | Base URL of the Better Auth service. Must expose `/api/auth/` routes including OTP and JWKS (`/api/auth/jwks`). | Yes: hard crash if absent |
| `EXPO_PUBLIC_GRAPHQL_SERVER_ENDPOINT` | Base URL of the NestJS GraphQL API. Apollo appends `/graphql`. | Yes: hard crash if absent |
| `EXPO_PUBLIC_INFERENCE_ENDPOINT` | Base URL of the inference gateway. Must expose: `/v1/inference/jobs`, `/v1/chat/completions`, `/v1/chat/completions/batch`, `/api/attestation/report` (NEAR AI Cloud v2 attestation contract for E2EE cloud inference). | Yes: hard crash if absent |

> **Backend availability, as of today.** `mera-inference-gateway` **is published** at
> [github.com/Mera-News](https://github.com/Mera-News), so you can read, build, and deploy the inference
> relay yourself. The auth service and the GraphQL API (`mera-server`) are **not yet published**:
> `EXPO_PUBLIC_AUTH_ENDPOINT` and `EXPO_PUBLIC_GRAPHQL_SERVER_ENDPOINT` currently require either a Mera
> Labs deployment or your own implementation of the contracts above. Both are being made source-available;
> see [Backend source-availability](#backend-source-availability-in-progress).

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

## Backend source-availability (in progress)

**Target: before September 2026.**

Publishing the client proves what the app *sends*. It proves nothing about what happens next. And every
byte the app sends about *you* (your topics, your persona record, your push token, your session, your
subscription) currently lands in a closed service. That is the gap this work closes.

### The problem

The code that handles user data and the code that runs the news pipeline live in one codebase today.
Making the repository public is therefore not an option: it would publish the ingestion pipeline,
clustering, and ranking along with it. Separating the two properly is most of the work.

### The shape

A new source-available repository containing four deployable services, which together become the only
thing the app talks to:

| Service | Responsibility |
|---|---|
| `api` | The GraphQL API the app queries. User persona records, quota enforcement, config |
| `auth` | Better Auth: email OTP, sessions, account records, JWKS signing keys |
| `inference` | The E2EE inference relay (today's `mera-inference-gateway`) |
| `worker` | Background jobs: notification scheduling and delivery |

Everything that knows who you are moves here. The news backend stays closed and becomes a pure article
service.

### The invariant this buys

> ⚠️ **Everything in this subsection is the design being built, not the system running today.** It is
> written in the future tense deliberately. Do not cite it as a description of current behaviour.

The closed news service will receive topic phrases with **no identifier of any kind**: no user ID, no
session, no device ID, no client IP. The intent is that this is structural rather than a promise:

- Outbound headers will be a **fixed allowlist built once at adapter construction**, with no per-request
  header parameter through which anything could be smuggled.
- A **test asserting set equality** against that allowlist, so adding a header fails the build.
- Typed DTOs only: no `context` / `headers` / `extra` escape hatch. No cookie jar, no
  `x-forwarded-for` propagation, no per-user connection pinning.
- The two systems will run on **separate databases with separate credentials and no cross-system
  database access**, so the closed side cannot read a user record even by mistake.

One thing here *is* already true and can be checked today: **no collection in any database links a user
to a topic.** Topics live in a shared cache keyed by the topic text itself, with no owner field, swept
14 days after anyone last requested them. What the migration adds is that identity stops travelling
alongside the topic text in the same request, and that the separation becomes externally checkable
rather than something you take on trust.

### Running it yourself

Two ports make "download it and run it" real rather than theoretical:

| Port | Default for self-hosters | What it does |
|---|---|---|
| `NewsDataProvider` | Reference adapter over a public search API | Supplies articles, so you need none of Mera's pipeline |
| `EntitlementProvider` | `unlimited` | No billing account, no API key, no quota |

**What you get:** topic-driven discovery, per-country and per-publisher browsing, article detail,
related articles, and the entire on-device persona / scoring / feedback loop. A working, genuinely
private news reader.

**What you don't:** semantic retrieval, story clustering and everything built on it (dedup, story
following, popularity), breadth-ranked global headlines, and entity/geo/event enrichment. Keyword search
instead of meaning-based matching.

### What stays closed, and why

Ingestion, clustering, ranking, and billing internals. The idea is copyable; the infrastructure and the
cost engineering behind it are what the subscription pays for. The line we think is honest: **you should
be able to verify what happens to your data, not necessarily rebuild the product from our source.**

### Known gaps this does *not* close

Stated here rather than omitted:

- **Attestation is fetched but not verified** (see Architecture Overview above). Fail-closed quote
  verification in the client is the next wave. It lives entirely in this repository and costs no
  commercial secrecy.
- **No reproducible builds or signed release hashes yet.** You can read this source; you cannot yet prove
  the binary on your phone was built from it. Reproducible builds and `cosign`-signed image digests are
  planned.
- **Source code cannot prove which code a server runs.** This is true of every service that publishes a
  backend: Signal's server is published and unverified too; its guarantee comes from the protocol, not
  from the server source. A transparency report is planned so conduct under legal requests is at least on
  the record.
- **Account deletion does not yet cascade every collection** in a single pass.
- **Some retention windows are unbounded**: submitted unblock-request transcripts and per-day usage
  counts in particular.
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
