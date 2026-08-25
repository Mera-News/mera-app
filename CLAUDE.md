# CLAUDE.md

Mera is a React Native / Expo news app for iOS and Android, bundle id and package `com.mera.news`.
Expo SDK 55, React Native 0.83, React 19, TypeScript, dark mode only. Its own package.json and CI.

## Layout

| Path | What |
|---|---|
| `app/` | Expo Router routes. Routing only. |
| `components/custom/` | every screen and app component, one directory per feature |
| `components/ui/` | Gluestack primitives. Shared; one owner per wave. |
| `lib/` | all logic: `news-harness`, `database`, `stores`, `scheduler`, `llm`, `e2ee`, `subscription`, `security`, ~45 more. Path alias `@/*` maps to the project root. |
| `lib/generated/graphql-types.ts` | codegen output from `schema.gql`. Never hand-edited. |
| `lib/locales/` | 20 dictionaries. Translation is the last step of a wave. |
| `harness/` | simulator runbooks and screenshots, no code. `harness-local/` is a Node executor that never ships. `eval/` scores its runs; `qa/` is disposable evidence. |

## Commands

```bash
npm install && npx expo start   # then: npm run ios / npm run android
npm run lint                # expo lint.  npm test = jest.  npx tsc --noEmit
npm run codegen             # schema.gql -> lib/generated/graphql-types.ts
npm run update:production   # never a bare `eas update`: only these scripts upload Sentry source maps
```

## Load a skill

Read the skill before the code, even for a one-line fix. It carries this area's map,
invariants and traps.

| Work | Skill |
|---|---|
| Feed, cards, ordering, grouping, article detail, story timeline, `lib/news-harness` | `mera-app-feed` |
| WatermelonDB, migrations, Zustand stores, scheduler, Apollo, codegen | `mera-app-data` |
| Chat, tool calls, on-device LLM, E2EE, web search, fact-check | `mera-app-chat` |
| Onboarding, auth, PIN, persona, Mera Protocol, paywall, StoreKit | `mera-app-persona` |
| Driving the simulator or emulator, QA, local AI-flow iteration | `mera-app-harness` |

No skill owns `lib/{explore,news-search,tutorials,tracking,notifications,background,diagnostics,
observability,navigation,hooks,utils,config,layout,typography,user-context}`, most of `lib/services/`,
most loose `lib/*.ts` (notably `article-service.ts`, the main article GraphQL client), or
`components/custom/{for-you,config-panel,explore,profile,profile-hub,locations,notifications,
publication-preferences,saved-suggestions,not-interested,hygiene,tutorials}`. Read the code.

## Invariants

1. `/app` files route only. Screens live in `components/custom/{feature}/`.
2. WatermelonDB migrations are additive: never DROP+recreate `article_suggestions`. After a schema
   change, update `schema.gql` and run `npm run codegen`.
3. Settle copy in `lib/locales/en.json` first; translate the other 19 locales last, from exact keys.
4. Only the explicit logout button logs a user out. Gate screens on local identity, session as fallback.
5. Native-rebuild work leaves the wave: its own plan file plus a row in `../native-rebuild-plans.md`.
6. Never put an account id, email, or personal name into a checked-in file.
7. `.watchmanconfig` must never ignore `node_modules` or `.git`; Metro builds its module map from that crawl.
8. Verify UI changes on a simulator yourself before declaring them done. Load `mera-app-harness`.
9. Ask whether the server should do any client-side aggregation, filtering, or deduplication before
   you write it. Escalate at 50+ lines of aggregation logic or N sequential API calls.
10. The settings "Report a Bug" button renders in every build but is INERT in dev (Sentry is off
    unless `EXPO_PUBLIC_SENTRY_IN_DEV=true`, so `showFeedback()` no-ops). Never use it while in
    dev; nothing is sent and no error is shown.

## Deeper docs

- `NEWS_HARNESS.md` (379 lines): AI feed flow. `COMMANDS.md` (230): npm, Expo, EAS, OTA (silent), version bump.
- `harness/README.md` (243), `harness/README-android.md` (341). Gluestack: https://v4.gluestack.io/ui/docs/components/
