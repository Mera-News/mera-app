# CLAUDE.md

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

## Architecture

### Core Patterns

- **Auth**: Better Auth with email OTP via `authClient` (`lib/auth-client.ts`). Tokens in expo-secure-store (native) / AsyncStorage (web). Auth cookies auto-injected into GraphQL via `SetContextLink` in `lib/apollo-client.ts`. Logout must call `clearAuthStorage()`.
- **Data Fetching**: Apollo Client with `fetchPolicy: 'no-cache'` everywhere — intentional for real-time personalized content.
- **Navigation**: Expo Router file-based routing. Stack (`app/_layout.tsx`) + Native Tabs (`app/app_container/_layout.tsx`: News, Train, Review, Preferences).
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
  /app_container/           # Main tabs (news, train, review, preferences)
/components
  /ui/                      # Gluestack-based atomic components
  /custom/                  # All app-specific components
    *.tsx                   # Shared components (MeraLogo, cards, chips, etc.)
    /auth/                  # Auth screens
    /chat/                  # Chat UI components
    /config-mera/           # App preferences & settings screens
    /config-panel/          # Review panel (persona + sources drill-downs)
    /for-you/               # Main news feed screen
    /news-detail/           # Cluster/article detail screens
    /onboarding/            # Onboarding flow
    /persona-chat/          # Persona chat variants
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

### Local Database (WatermelonDB)

Schema lives in `lib/database/schema.ts`; migrations in `lib/database/migrations.ts`. Migrations are a linear chain — add a new `{ toVersion: N, steps: [...] }` and bump `appSchema.version`.

**`article_suggestions` is an ephemeral cache.** Every row is rebuilt by `syncFeed` from the server's 24h window. For schema changes to this table (or `article_suggestion_facts`), it's always safe — and often simplest — to DROP and recreate it in the migration rather than writing column-by-column alter steps. See v8 and v9 migrations for the pattern (then applied to `cluster_suggestions`; same pattern now applies to `article_suggestions`). Do NOT apply this to `facts`, `user_personas`, `conversations`, `messages`, `inference_jobs`, or any other table — those hold user-owned or long-lived state and must be migrated, not wiped.

## Workflows

**Adding a GraphQL Query**: Update `schema.gql` → add query in service file → `npm run codegen` → import types.

**Adding a Screen**: Create component in `components/custom/{feature}/` → create minimal route in `app/` → configure `Stack.Screen` if needed.

**Gluestack UI Reference:** Component docs live at `https://v4.gluestack.io/ui/docs/components/`. Verify props and variants there before implementing new UI.

**State Management**: Zustand for shared/global/persisted state (stores in `lib/stores/`). React hooks (`useState`, `useRef`) for local/ephemeral state. Use `useShallow` for multi-value selectors. Use `getState()` for non-reactive access.

**Backend-First**: Before writing complex client-side data aggregation, filtering, or deduplication — evaluate if the backend should handle it instead. Ask the user about backend changes if you'd need 50+ lines of aggregation logic or N sequential API calls.

**LLM Models:** Model constants are the single source of truth in `lib/llm/constants.ts` — check there before assuming model names.

**LLM Prompt Budget**: Context window is 4096 tokens (`n_ctx`), max output 1024 — all input (system prompt + user context + conversation history) must fit in ~3072 tokens. Both local and cloud paths enforce the same budget. Target device: iPhone 15 Pro+ (8GB). When editing prompts in `lib/mera-protocol/prompts.ts`, verify token estimates via the logs.

**Cloud Relevance Scoring Config**: `lib/mera-protocol/scoring-service.ts` owns `ARTICLES_PER_SCORE_PROMPT` and `SCORE_BATCH_MAX_TOKENS` — do not change these constants without running a scored comparison on a representative feed. Debug prompt dumps are gated by `EXPO_PUBLIC_DUMP_QUERY_FOR_DEBUGGING=true`; see `lib/mera-protocol/scoring-service.ts` for details.

## Design Pattern Guidelines

**Never introduce a pattern without first naming the specific friction it removes.** A pattern pays for flexibility in one controlled place instead of everywhere — but without real friction, it's just extra abstraction.

**Decision tree — identify the pain first:**
1. **Creating objects** hurts? (too many params, unclear defaults) → Builder, Factory
2. **Fitting things together** hurts? (external APIs leaking in, complex subsystems) → Adapter (translation only — no business logic), Facade
3. **Behaviour keeps changing**? (growing if/else, swappable logic) → Strategy, State, Chain of Responsibility

**Avoid Singleton** unless stateless/safe to share. Prefer dependency injection. Three similar lines of code is better than a premature abstraction.
