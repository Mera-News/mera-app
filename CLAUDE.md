# CLAUDE.md

## Model Usage Policy

**Do it yourself when the context is already loaded and the change is small — ≤3 files and
~150 lines.** A cold subagent costs ~30–60s of warm-up plus context rediscovery, so delegating
under that line is slower *and* dearer. Past it, or whenever work can run in parallel, delegate.
Applies to **Fable and Opus alike**.

### Delegate — match the row, don't deliberate

| Situation | Action |
|---|---|
| ≤3 files, ~150 lines, context already loaded | Do it yourself |
| Must be serialized in one file | Do it yourself — never two agents on one file |
| >3 files or >150 lines, or spans repos | Delegate |
| ≥3 independent units that can run at once | Delegate, 1 agent per unit |
| ≥5 near-identical edits (locales, DTOs, call sites) | Delegate, batched across Haiku agents |
| Investigation that would flood context | Delegate to `Explore` |

Units that share an undecided question are **not** independent. Decide it first and repeat the
answer in every prompt, or keep them in one agent — parallel agents inventing their own answers
to the same question is the top failure mode of fan-out.

### Model per agent

| Model | Use for |
|---|---|
| **Opus** | Tricky logic, cross-cutting or multi-repo changes, large files, and any scout that may later implement |
| **Sonnet** | Well-scoped single-concern work: one feature file, one service, one test suite |
| **Haiku** | Mechanical volume: locale translations, string/import/rename sweeps, boilerplate, log triage |

### Plan with scouts, then reuse them

For multi-area work, spawn one **Opus** scout per area to plan that area — use
`general-purpose`, not `Plan`/`Explore`, which are read-only and can't implement. Then implement
by `SendMessage`-ing the same agent: it resumes with its context intact and near-zero warm-up.
A resumed agent keeps its spawn-time model, so spawn scouts at the model that should write the code.

**How many:** 3–6 units → 1 agent each; 7–15 → batch into 6–10; 16+ → batch into 12–24.
Ceiling 24 concurrent (Opus ≤6, Sonnet ≤12, Haiku ≤24). Send every agent for a stage in **one
message** so they actually run concurrently.

Every subagent prompt states: **objective, absolute file paths, decisions already made,
constraints, output format, and what is out of scope.** Tell scouts to escalate ambiguity rather
than guess. Never `git stash` / `git reset` in a subagent — they share this working tree.

## Project Overview

Mera is a React Native/Expo news personalization app for iOS and Android (bundle ID / package: `com.mera.news`).

## Commands

```bash
npm install && npx expo start     # Install + start dev server
npm run ios                       # iOS simulator
npm run android                   # Android emulator
npm run lint                      # ESLint
npm run codegen                   # Generate GraphQL types from schema.gql → lib/generated/graphql-types.ts
```

### EAS Builds & Updates

```bash
eas build --profile development|preview|production
eas submit --platform ios|android
eas update --branch production|preview|development --message "description"
```

OTA updates work for JS/TS/styling/GraphQL changes. Native builds required for native deps, SDK version, `app.json` native config, or native modules. Runtime version policy is `appVersion`. Update `owner` and `projectId` in `app.json` / `eas.json` to your own EAS account before running EAS commands.

### Simulator Harness (verify UI changes yourself)

**Full runbook: [harness/README.md](harness/README.md) — read it before first use.** The `iPhone 17 Pro`
simulator runs the dev client with a permanent resident account (real prod data, fully onboarded).
Drive it from Bash with `agent-device` instead of asking the user for screenshots — a JS edit is
on-screen via Fast Refresh in ~6s, so verify every UI change this way before declaring it done.

```bash
cd mera-app                                    # sessions are workspace-cwd-scoped — always run from here
agent-device open com.mera.news --device "iPhone 17 Pro"
agent-device snapshot -i                       # accessibility tree with @refs
agent-device press @e12 --settle               # tap (use --settle on every mutation)
agent-device press 'id=<testID>' --settle      # tap by testID
agent-device screenshot out.png                # then Read the PNG
agent-device close
```

Rules that save time (details + more traps in the README):
- testIDs surface only in `snapshot --raw --json` (`identifier` field), not in `snapshot -i`.
  Convention: `{surface}-{element}` kebab-case; card roots `card-${suggestion._id}`; actions
  `card-action-{name}` (repeat per card — scope by card root). When adding UI, add testIDs.
- testID works on `Pressable`/`View`/`Box`; gluestack `InputField` swallows it — tag the wrapper.
  `NativeTabs.Trigger` accepts none — drive tabs by label/icon (`id=house.fill` etc.).
- Metro must be running (`npx expo run:ios --device "iPhone 17 Pro"` serves it); a `simctl launch`
  can boot a stale bundle — force reload via
  `xcrun simctl openurl booted "com.mera.news://expo-development-client/?url=http%3A%2F%2F127.0.0.1%3A8081"`.
- A "black screen" is usually a LogBox toast, not a crash — `agent-device react-native
  dismiss-overlay` and check `agent-device logs` before assuming a wedge.
- Never run file-editing subagents while the user is typing in the simulator — every save fires a
  Fast Refresh that stomps their input. The resident account is the user's to log in; never log it
  out.

## Architecture

### Core Patterns

- **Auth**: Better Auth with email OTP via `authClient` (`lib/auth-client.ts`). Tokens in expo-secure-store (native) / AsyncStorage (web). Auth cookies auto-injected into GraphQL via `SetContextLink` in `lib/apollo-client.ts`. Logout must call `clearAuthStorage()`.
- **Data Fetching**: Apollo Client with `fetchPolicy: 'no-cache'` everywhere — intentional for real-time personalized content.
- **Navigation**: Expo Router file-based routing. Stack (`app/_layout.tsx`) + Native Tabs (`app/logged-in/app_container/_layout.tsx`: Feed (scrolling insert-only feed, landing tab), Dashboard (`for_you` route — sectioned news), Explore (`around`), Profile, Settings).
- **UI**: NativeWind + Gluestack UI v4. Dark mode only (`mode="dark"`). Colors in `tailwind.config.js`.
- **GraphQL**: Schema in `schema.gql` → codegen → `lib/generated/graphql-types.ts`. Always regenerate after schema changes.

### Routing vs Rendering (IMPORTANT)

`/app` files = routing ONLY. No rendering, state, or business logic. All screen components go in `/components/custom/{feature}/`.

```tsx
// app/my-route.tsx — routing only
export default function MyRoute() {
  const { id } = useLocalSearchParams();
  return <MyScreen id={id} />;
}

// components/custom/feature/MyScreen.tsx — all rendering logic here
```

### Project Structure

```
/app                        # Expo Router routes (routing only)
  /_layout.tsx              # Root: ApolloProvider + GluestackUIProvider + SafeAreaProvider
  /logged-in/app_container/ # Main tabs: Feed, Dashboard (for_you), Explore (around), Profile, Settings
/components
  /ui/                      # Gluestack-based atomic components
  /custom/                  # All app-specific components
    *.tsx                   # Shared components (MeraLogo, cards, chips, etc.)
    /auth/                  # Auth screens
    /chat/                  # Chat UI components
    /config-mera/           # App preferences & settings screens
    /config-panel/          # Review panel (persona + sources drill-downs)
    /for-you/                # Dashboard screen (for_you route) — sectioned news
    /feed/                   # Feed tab: scrolling insert-only feed + inline feedback surface
    /news-detail/            # Cluster/article detail screens
    /onboarding/             # Onboarding flow
    /persona-chat/           # Persona chat variants
/lib
  /apollo-client.ts         # Apollo Client setup
  /auth-client.ts           # Better Auth client
  /stores/                  # Zustand stores
  /generated/graphql-types.ts  # Auto-generated (DO NOT EDIT)
```

### Config

- **Env vars** (`.env`): `EXPO_PUBLIC_AUTH_ENDPOINT`, `EXPO_PUBLIC_GRAPHQL_SERVER_ENDPOINT`
- **Path aliases**: `@/*` → project root
- **iOS + Android** builds. New Architecture + React Compiler enabled.

**Watchman / Metro gotcha:** Never put `node_modules` (or `.git`) in `.watchmanconfig`'s `ignore_dirs`. Metro builds its module-resolution file map from the Watchman crawl, so ignoring `node_modules` makes every package invisible and produces `Unable to resolve module ...` for files that plainly exist on disk (e.g. `expo-router/entry`). `.watchmanconfig` should only ignore build-output dirs (`.expo`, `ios/build`, `ios/Pods`, `android/build`, etc.). To clear a Watchman recrawl warning, just reset the watch (`watchman watch-del <path> ; watchman watch-project <path>`) — that resets the recrawl counter without touching `ignore_dirs`.

### Local Database (WatermelonDB)

Schema lives in `lib/database/schema.ts`; migrations in `lib/database/migrations.ts`. Migrations are a linear chain — add a new `{ toVersion: N, steps: [...] }` and bump `appSchema.version`.

**`article_suggestions` (and `article_suggestion_facts`) are resyncable, but a wipe is not free.** Every row is eventually rebuilt by `syncFeed` from the server's 24h window, but default to **additive `addColumns`** for schema changes to these tables anyway — DROP+recreate leaves the feed empty until a full re-sync plus the first cloud scoring round trip, and it destroys the 48h score-propagation donor pool. The 2026-07 v36→v43 OTA shipped migrations v37/v41 that DROP+recreated `article_suggestions` for purely additive changes (11 optional columns, then `scored_at` — no removal/rename/semantics change required it) and wiped every device's feed as a side effect; both were rewritten additively in r5 P7b. Treat that incident as the cautionary example, not a pattern to copy.

Reserve DROP+recreate for genuinely incompatible changes — a column's type or semantics changing, or a status-machine change. When a wipe is truly unavoidable, preserve scoring state in the same migration instead of losing it: rename the old table, create the new one, `INSERT INTO ... SELECT ...` the surviving rows across, then drop the renamed original:

```sql
ALTER TABLE article_suggestions RENAME TO article_suggestions_old;
-- createTable({ name: 'article_suggestions', columns: [...new shape] })
INSERT INTO article_suggestions (id, _status, _changed, article_id, created_at, first_pub_date, relevance, reason, status, scored_at)
  SELECT id, _status, _changed, article_id, created_at, first_pub_date, relevance, reason, status, scored_at
  FROM article_suggestions_old;
DROP TABLE article_suggestions_old;
```

WatermelonDB's own `_status`/`_changed` metadata columns must be carried across along with the business columns — dropping them breaks sync bookkeeping for surviving rows. At minimum preserve `(id, article_id, created_at, first_pub_date, relevance, reason, status, scored_at)`.

Any migration touching `article_suggestions` must keep the convergence test in `lib/database/__tests__/migrations.test.ts` green — it reconstructs the migration chain's resulting column set and equality-checks it against `schema.ts`, and rejects duplicate column adds.

Do NOT apply any of this — additive or wipe — to `facts`, `user_personas`, `conversations`, `messages`, `inference_jobs`, or any other table — those hold user-owned or long-lived state and must be migrated, not wiped.

## Workflows

**Adding a GraphQL Query**: Update `schema.gql` → add query in service file → `npm run codegen` → import types.

**Adding a Screen**: Create component in `components/custom/{feature}/` → create minimal route in `app/` → configure `Stack.Screen` if needed.

**Gluestack UI Reference:** Component docs live at `https://v4.gluestack.io/ui/docs/components/`. Verify props and variants there before implementing new UI.

**State Management**: Zustand for shared/global/persisted state (stores in `lib/stores/`). React hooks (`useState`, `useRef`) for local/ephemeral state. Use `useShallow` for multi-value selectors. Use `getState()` for non-reactive access.

**Backend-First**: Before writing complex client-side data aggregation, filtering, or deduplication — evaluate if the backend should handle it instead. Ask the user about backend changes if you'd need 50+ lines of aggregation logic or N sequential API calls.

**LLM Models:** Model constants are the single source of truth in `lib/llm/constants.ts` — check there before assuming model names.

**LLM Prompt Budget**: Context window is 4096 tokens (`n_ctx`), max output 1024 — all input (system prompt + user context + conversation history) must fit in ~3072 tokens. Both local and cloud paths enforce the same budget. Target device: iPhone 15 Pro+ (8GB). When editing prompts in `lib/mera-protocol/prompts.ts`, verify token estimates via the logs.

**Cloud Relevance Scoring Config**: `lib/mera-protocol/scoring-service.ts` owns `ARTICLES_PER_SCORE_PROMPT` and `SCORE_BATCH_MAX_TOKENS` — do not change these constants without running a scored comparison on a representative feed. Debug prompt dumps are gated by `EXPO_PUBLIC_DUMP_QUERY_FOR_DEBUGGING=true`; see `lib/mera-protocol/scoring-service.ts` for details.

**News-harness / AI flows**: For any task touching AI flows — prompts, relevance scoring, topic generation, feed relevance, or the article-feedback agent — the pure logic lives in `lib/news-harness/` (RN-free, ports-and-adapters; the `lib/mera-protocol/*` and `lib/llm/agents/*` files are thin shims over it). Read [NEWS_HARNESS.md](NEWS_HARNESS.md) first. It also documents `harness-local/` (Node/tsx), used whenever the user asks to iterate/tune the feed locally: tweak a prompt/config → run the pipeline script → `harness:compare` two runs → repeat, then verify with `tsc` + `jest lib/news-harness` since harness code is shipped app code.

**Translation is always the last step.** When a task adds or changes user-facing strings, implement and verify the feature in English first (`lib/locales/en.json`), then translate to all other supported locales in `lib/locales/` (`ar`, `de`, `es`, `fr`, `hi`, `id`, `it`, `ja`, `ko`, `nl`, `pl`, `pt-BR`, `ru`, `th`, `tr`, `uk`, `vi`, `zh-CN`, `zh-TW`) as the final step, once the English copy is settled. Fan this out to **Haiku** subagents per the Model Usage Policy sizing rule, giving each the exact new/changed keys, the English source strings, and its target locale file paths, so each subagent can translate directly without rediscovering context.

## Design Pattern Guidelines

**Never introduce a pattern without first naming the specific friction it removes.** A pattern pays for flexibility in one controlled place instead of everywhere — but without real friction, it's just extra abstraction.

**Decision tree — identify the pain first:**
1. **Creating objects** hurts? (too many params, unclear defaults) → Builder, Factory
2. **Fitting things together** hurts? (external APIs leaking in, complex subsystems) → Adapter (translation only — no business logic), Facade
3. **Behaviour keeps changing**? (growing if/else, swappable logic) → Strategy, State, Chain of Responsibility

**Avoid Singleton** unless stateless/safe to share. Prefer dependency injection. Three similar lines of code is better than a premature abstraction.
