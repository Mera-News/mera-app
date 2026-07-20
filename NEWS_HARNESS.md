# NEWS_HARNESS.md — operating manual for the news-harness AI-flow system

This is the manual to follow when a task means changing how the feed is built:
prompts, relevance scoring, topic generation, feed relevance, or the article
feedback agent — and especially when the user says something like *"update the
news-fetching / scoring logic to XYZ and run the harness locally until the
output looks right."* Read it before touching any file under
`lib/news-harness/`.

## 1. What this is

**`lib/news-harness/`** is the app's AI-flow system: pure, RN-free logic for
persona → topic generation → article candidates → relevance scoring → reasons,
plus the persona-update and article-feedback chat "brains." It imports nothing
from React Native / Expo / WatermelonDB / Zustand / `lib/logger` /
`lib/config/endpoints` — every side effect (LLM calls, GraphQL, persistence,
logging) is injected through the port interfaces in `core/ports.ts`. Because it
is shared code, the app runs this exact logic in production through thin
adapters, so a change validated locally is what the app ships.

**`harness-local/`** is a standalone Node/tsx executor that implements those
same ports against real backends (NEAR AI Cloud API, the real GraphQL server, a
JSON persona fixture) so you can run the actual flows from a terminal, dump exact
prompts/outputs, and iterate on prompts/config without a device. It is excluded
from the app's `tsconfig.json`, Jest run, and EAS bundling — it never ships.

## 2. Architecture

### Module map (`lib/news-harness/`)

```
core/
  types.ts        — Fact, HarnessArticle, ScoringCandidate/Result, BatchCall,
                    ToolDefinition, ProposalAction, StagedProposal, feedback types
  ports.ts        — LlmPort, NewsApiPort, PersonaStorePort, SuggestionSinkPort,
                    HarnessLogger (+ NOOP_LOGGER) — the injected seams
  config.ts       — HarnessConfig + DEFAULT_HARNESS_CONFIG (exact prod values)
prompts/
  prompts.ts            — every system prompt + prompt/tool-definition builders
  questionnaire-data.ts — questionnaire levels, attribute maps, example questions
persona-management/
  fact-rules.ts          — filterNewFacts + fact-acceptance rules (empty/too-long/meta/duplicate)
  topic-generation.ts    — generateTopicsForFactsBatch (fact → search topics)
  persona-agent-core.ts  — PersonaUpdateAgent brain (system prompt, context, tools)
article-pipeline/
  scoring.ts     — batched relevance calls, reason calls, response parsing, bucketing
  candidates.ts  — deriveTopicTexts, buildCandidatesFromArticles
  pipeline.ts    — runArticlePipeline: facts→topics→ids→articles→candidates→scores→reasons
scoring-engine/
  relevance.ts       — deterministic math affinity/penalty engine; ALWAYS the
                       persisted score authority. No freshness/age-decay term
                       (removed Round 3 — see Config philosophy below).
  judge.ts / judge-calls.ts — LLM judge over the math score. ADVISORY ONLY
                       (Round 3): authors the user-facing note; its returned
                       score is never applied, only recorded (+ the >0.3-delta
                       `override` flag) as a `CalibrationCase`.
  calibration.ts     — rolling-window override tracking + the user-gated
                       gateway constant-tuning loop; unchanged by the
                       advisory-judge move, still fed by the override flag.
  run-stage.ts       — computeAndJudge: compute math → persist math → judge
                       (advisory) → note.
feed-select/
  ownership.ts   — resolveOwnership / resolveOwningFact + bucketOf: the shared
                   ownership + display-tier cores, used by both the fact-rows
                   feed selector (`lib/stores/fact-rows-selector.ts`) and the
                   per-fact scoring batcher (`lib/services/fact-batching.ts`).
                   The old sectioned/two-zone `sections.ts` and swipe-deck
                   `deck.ts` were deleted in Round 3 — only these ownership
                   cores (+ `fact-stats.ts`) remain here.
article-feedback/
  agent-core.ts  — ArticleFeedbackAgent brain (system prompt, context, tools, propose/confirm)
index.ts         — public surface (re-exports every module above)
__tests__/       — unit tests incl. config.test.ts (pins every default) and
                   golden-prompts.test.ts (prompt-drift guard)
```

### Ports and who implements them

The harness declares five ports (`core/ports.ts`); two sets of adapters
implement them:

| Port | App adapter (production) | harness-local adapter |
|------|--------------------------|-----------------------|
| `LlmPort` | cloud path via `lib/llm/cloudComplete.ts` (inference gateway) | `adapters/nearai-llm.ts` — **direct** to NEAR AI (`https://cloud-api.near.ai/v1`), `enable_thinking:false` parity + `reasoning_content` fallback |
| `NewsApiPort` | app GraphQL client | `adapters/graphql-news-api.ts` (live) or an in-script replay stub |
| `PersonaStorePort` | WatermelonDB-backed | `adapters/file-persona-store.ts` (JSON fixture) |
| `SuggestionSinkPort` | WatermelonDB writes | `adapters/memory-suggestion-sink.ts` (in-memory) |
| `HarnessLogger` | `lib/news-harness-app/logger-adapter.ts` (Sentry-backed) | `adapters/console-logger.ts` |

### Config philosophy

`DEFAULT_HARNESS_CONFIG` in `core/config.ts` holds the **exact current
production values** (batch size 5, `scoreBatchMaxTokens` 80, score temp 0.1,
reason temp 0.2, `discardFloor` 0.4, bucket cutoffs medium 0.6 / high 0.8 /
emergency 1.0, `limitPerTopic` 20, topics 16 cloud / 14 local, etc.).
`config.test.ts` pins every literal, so **changing a default is a product
change** and will fail that test until the test is updated deliberately. For
local experiments, do **not** edit the defaults — pass a per-run
`--config overrides.json` that is merged over the defaults for that run only.

`scoringEngine` (the math affinity engine, `relevance.ts`) has **no
freshness/age-decay component** — `W_FRESH` was removed in Round 3 and the
remaining seven positive weights (`W_TOPIC`/`W_BREADTH`/`W_GEO`/`W_ENTITY`/
`W_EVENT`/`W_PUB`/`W_POP`) were renormalized proportionally so full-saturation
affinity still lands ≈1.0; current values are in `core/config.ts`. The math
score is **always** what gets persisted — the LLM judge (`judge.ts`) is
advisory only: it authors the user-facing note, and its own score is recorded
solely as a calibration signal (the existing >0.3-delta `override` flag),
never applied to the live relevance. The calibration loop itself is
unchanged and stays user-gated.

### How the app consumes the same code (shim list)

These app-side files are thin adapters/re-exports over the harness — they keep
the production app on the harness path and must preserve byte-identical
behavior (the golden-prompt test guards this):

- `lib/mera-protocol/prompts.ts`, `questionnaire-data.ts`, `scoring-service.ts`,
  `topic-generation-service.ts`
- `lib/chat-tools/tool-handlers.ts`
- `lib/llm/agents/PersonaUpdateAgent.ts`, `lib/llm/agents/ArticleFeedbackAgent.ts`
- `lib/llm/types.ts`, `lib/llm/cloudComplete.ts` (type re-exports)
- `lib/news-harness-app/logger-adapter.ts` (Sentry `HarnessLogger`)

> Local (llama.rn) on-device prompts are **not** exercised by harness-local —
> it drives the cloud prompts only.

### Feed assembly & per-fact cloud scoring (app-side, Round 3)

Two app-side files (outside `lib/news-harness/`, so not harness-pure, but
built directly on the `feed-select/ownership.ts` cores above) replaced the
old sectioned/two-zone For-You view and its single-shot cloud scoring job:

- **`lib/stores/fact-rows-selector.ts`** — the pure selector behind the
  For-You view. There is no more sectioned/watermark/two-zone/deck view: the
  feed is per-fact horizontal rows (+ a trailing "Also for you" catch-all),
  built from the render-gated 24h suggestion pool via `resolveOwnership`. A
  card enters its row once its note exists (or is deliberately reason-skipped).
- **`lib/services/fact-batching.ts`** + **`lib/services/scoring-pipeline.ts`**
  — cloud scoring is per-fact batched. Candidates are grouped by their
  primary (strongest owning) fact — `groupCandidatesByPrimaryFact`, reusing
  `resolveOwningFact` — chunked per fact (facts with <3 candidates merge into
  a `factId: null` tail). Per batch: the math score is computed and persisted
  **immediately**; then ONE combined judge+notes cloud job runs per batch,
  whose only effect is filling in notes — the judge never rewrites the
  already-persisted math score (advisory-only, see Config philosophy below).

## 3. Running locally

### Prerequisites

- `npm install` in `mera-app`.
- A NEAR AI key. Resolution order: `NEWS_HARNESS_NEARAI_API_KEY` (from
  `harness-local/.env.harness`) → else `NEAR_AI_DEVELOPMENT_KEY` from the
  repo-root `.env`. If the dev key is already in `.env`, `.env.harness` is
  optional (copy it from `.env.harness.example` only if you need a non-`local`
  target or overrides).
- Nothing to seed by hand: the first script run auto-bootstraps
  `.local-test-data/` at the repo root and seeds `persona.json` from
  `harness-local/fixtures/persona.example.json`.

### The three npm scripts

**`npm run test-news-harness-persona-management`** — fact-acceptance rules +
cloud topic generation over `.local-test-data/persona.json`.
Flags: `--label <name>`, `--facts <path>`, `--all` (regenerate topics for every
fact, not just those lacking `metadata.topics`), `--write-back` (persist
generated topics back into the persona JSON — omit for a read-only run).
Produces run-dir: `config.json`, `persona.json`, `topics.json`, `llm-calls.json`,
`summary.json`.

**`npm run test-news-harness-article-pipeline`** — full `runArticlePipeline`
end-to-end: fetch article ids/articles for the persona's topics, build
candidates, batch-score, bucket, generate reasons.
Flags: `--label <name>`, `--facts <path>`, `--limit-per-topic <n>`,
`--articles-from <runDir>` (replay a prior run's article set instead of a live
fetch — **no GraphQL, no quota spend**), `--config <overrides.json>`
(`ArticlePipelineConfig` field overrides).
Produces run-dir: `config.json`, `topics.json`, `article-ids.json`,
`articles.json`, `candidates.json`, `scores.json`, `llm-calls.json`,
`summary.json`.

**`npm run harness:compare -- <runDirA> <runDirB>`** — diffs two runs: config
deltas, summary-stat deltas, a bucket-transition matrix (DISCARD is a
first-class row/col), kept↔discarded flips, the top-10 raw-score movers, and
articles unique to either run. Warns loudly if the two runs don't share the same
article set (pair with `--articles-from` for apples-to-apples).

### The golden-label eval engine (`eval/`)

`eval/` at the repo root is the **tracked** golden-label eval engine — it
scores a run's `scores.json` against 1,000 persona-anchored golden labels and
reports a confusion matrix, per-tier precision/recall, and the leak/miss
metrics that matter for the product. `.local-test-data/` stays the disposable,
gitignored data dir for run artifacts, the persona fixture, and the auth
cache — only the eval engine itself (script, labels, `--config` overrides) is
tracked in `eval/`. See `eval/README.md` for the full loop, the tier contract,
the noise floor, and how to regenerate golden labels. Run it with
`npm run eval:golden -- <runDir> [--verbose]`.

### Backend targets & auth

Set `NEWS_HARNESS_TARGET` in `.env.harness`:

- `local` (default) — no auth; mera-server's GraphQL runs a dev-user bypass when
  `NODE_ENV !== 'production'`.
- `staging` / `prod` — requires `NEWS_HARNESS_AUTH_ENDPOINT` +
  `NEWS_HARNESS_AUTH_EMAIL`; runs the real Better Auth email-OTP flow on first
  run, prompts for the OTP, and caches the session in
  `.local-test-data/.auth-cache.json`.

> **Quota warning:** on `staging`/`prod`, `getArticlesForTopicsByIds` is the
> same delivery point that spends the user's **daily article cap** as the
> production For-You feed. Every fresh live fetch spends from it — use
> `--articles-from` for iteration.

### Fetching from staging/prod (live backend)

This is the battle-tested recipe for pointing the harness at a real backend
instead of `local`.

**1. Endpoints (`harness-local/.env.harness`):**

```
NEWS_HARNESS_TARGET=prod
NEWS_HARNESS_GRAPHQL_ENDPOINT=https://graphql.mera.news/graphql
NEWS_HARNESS_AUTH_ENDPOINT=https://auth.mera.news
NEWS_HARNESS_AUTH_EMAIL=<test account email>
```

Staging equivalents: `https://graphql.staging.mera.news/graphql` and
`https://auth.staging.mera.news`.

> **The trailing `/graphql` is required.** The app's `apollo-client.ts` builds
> its URI as `` `${EXPO_PUBLIC_GRAPHQL_SERVER_ENDPOINT}/graphql` `` — it always
> appends the path itself. `harness-local/config/env.ts` does **not**; it uses
> `NEWS_HARNESS_GRAPHQL_ENDPOINT` verbatim as the request URL. So the harness
> env var must already include `/graphql`, or every request 404s with
> `Cannot POST /`.

Use a dedicated test account (e.g. `meratestNN@gmail.com`) rather than a
personal one — every live fetch spends *that account's* daily article quota
(see below).

**2. Auth.** Running a script against `staging`/`prod` interactively prompts
`Enter OTP:` (code emailed via MailerSend) and then caches the session in
`.local-test-data/.auth-cache.json` for ~6 days (`harness-local/adapters/auth.ts`,
`SESSION_MAX_AGE_MS`) — subsequent runs are non-interactive. When Claude is
driving the flow and can't forward stdin to the OTP prompt, do the exchange
manually and write the cache file directly:

1. `curl -X POST {AUTH}/api/auth/email-otp/send-verification-otp -H 'content-type: application/json' -d '{"email":"<email>","type":"sign-in"}'` —
   user relays the 6-digit code from their inbox.
2. `curl -D - -X POST {AUTH}/api/auth/sign-in/email-otp -d '{"email":"<email>","otp":"<code>"}'` —
   capture the `set-cookie` value (name=value only, before the first `;`).
3. Write `.local-test-data/.auth-cache.json` as:
   ```json
   { "cookie": "<name=value>", "savedAt": "<ISO timestamp>" }
   ```
   This matches the `AuthCache` shape in `harness-local/adapters/auth.ts`.
   **Never print or log the cookie value.**

**3. Quota behavior observed on prod.** `articlesForTopicsByIds` is the point
that reserves the account's daily article quota; a single full run with
~185 topics pulled the account's request/day cap (1,000 articles) and
reported `dailyLimitReached: true` with `resetAt` (midnight UTC) in
`summary.json`. `articleIdsForTopics` (the topic search) is **not**
quota-gated — only hydration is. If the account's plan is upgraded mid-day,
retry the run: the id search still succeeds and hydration picks up the new
cap. After a capped live fetch, iterate with `--articles-from <that run>`
replays (zero quota, LLM cost only).

### Run-dir artifact reference (`.local-test-data/runs/<ts>-<label>/`)

- `config.json` — resolved config (defaults ± `--config`) + `gitSha`, target,
  model, facts path, replay source.
- `topics.json` — generated topics (per-fact for persona runs; flat list for
  pipeline).
- `article-ids.json` / `articles.json` / `candidates.json` — streamed pipeline
  stages (the inputs a `--articles-from` replay reads back).
- `scores.json` — per-article rows: `id`, `titleEn`, `rawScore`,
  `bucketedScore`, `bucket`, `kept`, `reason`, `matchedTopics`,
  `relatedFactIds`, `failed`.
- `llm-calls.json` — full prompts/outputs/latency/finishReason/usage per call
  (**the prompt-inspection artifact**).
- `summary.json` — bucket counts, discard rate, mean/median raw score, stage
  timings, token usage, `gitSha`.

## 4. The iteration playbook (for Claude)

1. **Establish/verify fixture facts.** Open `.local-test-data/persona.json`. If
   it's still the seeded example or missing the persona traits the user's goal
   depends on, **ask the user for the persona data** (location, interests) or
   add representative facts — don't score against an unrepresentative persona.
2. **Generate topics** so the persona has `metadata.topics`:
   `npm run test-news-harness-persona-management -- --label topics --write-back`
   (add `--all` to regenerate existing ones).
3. **Baseline article-pipeline run.** If a backend is reachable, run live:
   `npm run test-news-harness-article-pipeline -- --label baseline`. If no
   backend is up, ask the user to start `local` mera-server or point you at an
   existing run dir to use as the `--articles-from` source. To establish the
   baseline against real staging/prod data instead of `local`, see
   [Fetching from staging/prod (live backend)](#fetching-from-stagingprod-live-backend)
   in §3.
4. **Modify the flow — know where each change lives:**
   - Prompts → `lib/news-harness/prompts/prompts.ts`.
   - Thresholds / batch size / temperature / model → **per-run**
     `--config overrides.json` for experiments; `core/config.ts` only for a
     shipped default change (a product change — see §2).
   - Pipeline shape / stage order → `article-pipeline/pipeline.ts`
     (+ `candidates.ts`, `scoring.ts`).
   - Topic generation → `persona-management/topic-generation.ts`.
   - Feedback agent → `article-feedback/agent-core.ts`.
5. **Re-run controlled:** replay the baseline's exact articles so the only
   variable is your change:
   `npm run test-news-harness-article-pipeline -- --label tweak-1 --articles-from .local-test-data/runs/<baseline-dir>`.
6. **Compare:** `npm run harness:compare -- <baseline-dir> <tweak-1-dir>` — read
   the bucket-transition matrix, the kept↔discarded flips, and the top movers to
   judge whether the change moved the feed the way the user wants. If the
   baseline run is scored against `eval/golden-labels.json` (i.e. it's a replay
   of `20260716-190647-prod-baseline`), also run
   `npm run eval:golden -- <tweak-1-dir>` — the confusion matrix and leak/miss
   metrics are ground truth, not just a relative diff. See `eval/README.md`.
7. **Repeat 4–6** until the user's stated goal is met. **Then** run the app-side
   verification, because harness code *is* app code:
   `npx tsc --noEmit`, `npx tsc --noEmit -p harness-local/tsconfig.json`, and
   `npx jest lib/news-harness` (which includes the golden-prompt drift test and
   `config.test.ts`). If you changed a `DEFAULT_HARNESS_CONFIG` value or a
   prompt, those tests will flag it — update them deliberately, never to silence
   a change you didn't intend.

**Caveats to hold in mind:**

- **Temperature nondeterminism:** scoring runs at temp 0.1 / reasons at 0.2, so
  repeat comparison runs (N≥2) before trusting a prompt delta. Measured on
  prod: two back-to-back full re-scores of the identical 1,000-article set
  produced near-identical aggregates (kept 387 vs 385, mean raw 0.382 vs 0.378)
  but ~36 kept↔discarded flips and individual swings up to ±0.55 — per-article
  scores are noisy even at temp 0.1. Judge experiments on aggregate metrics and
  bucket-transition matrices, not single-article deltas.
- **Quota:** live `staging`/`prod` fetches spend the daily article cap — replay.
- **Local-model prompts are not covered** by harness-local (cloud only).
- **Default-config edits are product changes** — `config.test.ts` will fail.

## 5. Guardrails

- **Import discipline:** nothing under `lib/news-harness/` may import
  `lib/logger`, `lib/config/endpoints`, `lib/database/*`, `lib/stores/*`, or any
  expo / react-native / watermelondb / zustand module. RN coupling goes through
  the ports only. `harness-local/` is Node-only and likewise never imports app
  RN modules.
- **Old-path shims keep byte-identical behavior.** The shim files in §2 and the
  golden-prompt test exist so production output doesn't drift when the harness
  changes — if `golden-prompts.test.ts` fails, that's the signal, not the enemy.
- **`.local-test-data/` is disposable** and fully gitignored (persona fixture,
  runs, auth cache). Delete it freely; the next run re-bootstraps it.
- **Never commit `.env.harness` or any key.** It's separately gitignored;
  `fixtures/persona.example.json` is the only tracked fixture.
