# CLAUDE.md

Mera is a React Native / Expo news app for iOS and Android, bundle id and package `com.mera.news`.
Expo SDK 55, React Native 0.83, React 19, TypeScript. Light and dark themes through the theme provider
(`lib/theme`); iOS keeps its native Dark pin (`UIUserInterfaceStyle`) until native plan N4. Its own package.json; GitHub CI (lint + jest) runs on `main` only. Ships via EAS. Never push `main` or publish an OTA unless the user asks.

## Where to edit

Edit only inside your slot under the workspace root's `.worktrees/`, never the owner checkout (a PreToolUse
hook blocks it). Claim, add, sync, finish and push with the workspace root's `node scripts/wt.mjs`. Run Metro
on your slot's port (`8090+N`), never `:8081`, which is the owner's.

## Layout

| Path | What |
|---|---|
| `app/` | Expo Router routes. Routing only. |
| `components/custom/` | every screen and app component, one directory per feature |
| `components/ui/` | Gluestack primitives. Shared; one owner per wave (a wave shares one slot). |
| `lib/` | all logic: `news-harness`, `database`, `stores`, `scheduler`, `llm`, `e2ee`, `subscription`, `security`, ~45 more. Path alias `@/*` maps to the project root. |
| `lib/generated/graphql-types.ts` | codegen output from `schema.gql`. Never hand-edited. |
| `lib/locales/` | 20 dictionaries. Translation is the last step of a wave. |
| `harness/` | simulator runbooks and screenshots, no code. `harness-local/` is a Node executor that never ships. `eval/` scores its runs; `qa/` is disposable evidence. |

## Commands

```bash
npm install && npx expo start --port <slot port>   # then: npm run ios / npm run android
npm run lint                # expo lint.  npm test = jest.  npx tsc --noEmit
npm run test:full           # full suite (jest + mock backend + Android Maestro); run before merging to main
npm run codegen             # schema.gql -> lib/generated/graphql-types.ts
npm run update:production   # never a bare `eas update`: only these scripts upload Sentry source maps
```

## Load a skill

Read the skill before the code, even for a one-line fix. It carries this area's map,
invariants and traps.

| Work | Skill |
|---|---|
| Feed, cards, ordering, grouping, article detail, story timeline, `lib/news-harness`, tabs and pages, World, Search, publication page, Sources rows | `mera-app-feed` |
| WatermelonDB, migrations, Zustand stores, scheduler, Apollo, codegen | `mera-app-data` |
| Chat, tool calls, on-device LLM, E2EE, web search, fact-check | `mera-app-chat` |
| Onboarding, auth, PIN, persona, Mera Protocol, paywall, StoreKit, tutorials, You tab (Profile, Settings, Sources, Backup), Notifications inbox | `mera-app-persona` |
| Driving the simulator or emulator, QA, local AI-flow iteration | `mera-app-harness` |
| Jest projects, MSW mock backend, Maestro/e2e-android, Stryker, deletion gate | `mera-app-testing` |

No skill owns `lib/{notifications,user-context,observability,utils,config}`, `components/custom/{toast,notifications}`
and most loose `lib/*.ts`. Read the code.

## Invariants

1. `/app` files route only. Screens live in `components/custom/{feature}/`.
2. WatermelonDB migrations are additive: never DROP+recreate `article_suggestions`. After a server schema
   change, copy `mera-server/src/schema.gql` here and run `npm run codegen`.
3. Settle copy in `lib/locales/en.json` first; translate the other 19 locales last, from exact keys.
4. Only the explicit logout button logs a user out. Gate screens on local identity, session as fallback.
5. Native-rebuild work leaves the wave: its own plan file under `../plans/`, listed in `../plans/PLAN_EXECUTION_ORDER.md`.
6. Never put an account id, email, or personal name into a checked-in file.
7. `.watchmanconfig` must never ignore `node_modules` or `.git`; Metro builds its module map from that crawl.
8. Verify UI changes on a simulator yourself before declaring them done. Load `mera-app-harness`.
9. Ask whether the server should do any client-side aggregation, filtering, or deduplication before
   you write it. Escalate at 50+ lines of aggregation logic or N sequential API calls.
10. The settings "Report a Bug" button renders in every build but is INERT in dev (Sentry is off
    unless `EXPO_PUBLIC_SENTRY_IN_DEV=true`, so `showFeedback()` no-ops). Never use it while in
    dev; nothing is sent and no error is shown.
11. Device attestation cannot run on a simulator or emulator. There, device sign-in works only against
    STAGING through the dev bypass token; prod needs email OTP. Setup: `mera-app-harness`.

## Deeper docs

- `NEWS_HARNESS.md`: AI feed flow. `COMMANDS.md`: npm, Expo, EAS, OTA (silent), version bump.
- `harness/README.md`, `harness/README-android.md`. Gluestack: https://v4.gluestack.io/ui/docs/components/
