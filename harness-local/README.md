# harness-local

A plain Node/tsx executor for `lib/news-harness` — the RN-free "AI-flow
system" that holds the pure persona-management and article-scoring logic used
by the app in production (persona → topics → article candidates → relevance
scoring → reasons).

**`lib/news-harness`** (in the main app source tree) is the logic layer: pure
functions and port interfaces (`LlmPort`, `NewsApiPort`, `PersonaStorePort`,
`SuggestionSinkPort`, `HarnessLogger` — see `lib/news-harness/core/ports.ts`),
with zero React Native / Expo / WatermelonDB / Zustand dependencies.

**`harness-local`** (this directory) is a standalone command-line harness
that implements those same ports against real backends — the NEAR AI Cloud
API, the real GraphQL server, a JSON file persona fixture — so you can run
the actual persona/topic-generation and article-scoring flows from a
terminal, inspect exact prompts/outputs, and iterate on prompts or config
without touching the app or a device. It is intentionally excluded from the
app's TypeScript project (`tsconfig.json`), Jest run, and EAS/Expo bundling —
it never ships.

## Setup

```bash
npm install
cp harness-local/.env.harness.example harness-local/.env.harness
# edit harness-local/.env.harness to taste
```

**NEAR AI key**: the harness resolves its NEAR AI Cloud API key as
`NEWS_HARNESS_NEARAI_API_KEY` (from `.env.harness`, explicit override — wins
if set) → else `NEAR_AI_DEVELOPMENT_KEY` from the repo-root `.env`. If the
dev key is already in `.env`, you don't need to set anything in
`.env.harness`. Loading the root `.env` never clobbers `NEWS_HARNESS_*`
values — `.env.harness` is loaded first and dotenv doesn't override
already-set variables.

That's it — the first script you run auto-bootstraps `.local-test-data/`
(creating the folder and seeding `.local-test-data/persona.json` from
`harness-local/fixtures/persona.example.json` if it isn't there yet) and logs
that it did so. Edit `.local-test-data/persona.json` afterwards to model the
user you want to test with.

All mutable harness state lives under `.local-test-data/` at the repo root
(gitignored in full): your own persona fixture (`persona.json`), run output
(`runs/`), and the cached auth session (`.auth-cache.json`). `harness-local/.env.harness`
is separately gitignored and holds local secrets. `harness-local/fixtures/persona.example.json`
is the only fixture tracked in git.

## Scripts

### `npm run test-news-harness-persona-management`

Runs the persona → topic-generation flow (`generateTopicsForFactsBatch` from
`lib/news-harness/persona-management/topic-generation.ts`) against the facts
in `.local-test-data/persona.json`, using the real NEAR AI Cloud API.

Flags:

- `--facts <id,id,...>` — only regenerate topics for these fact ids (default:
  all facts without `metadata.topics` yet — the same "skip already-generated"
  behavior as production).
- `--all` — force regeneration for every fact, including ones that already
  have `metadata.topics`.
- `--write-back` — persist the updated facts (with newly generated
  `metadata.topics` / `metadata.topicGenError`) back to
  `.local-test-data/persona.json`. Without this flag, the run is
  read-only — the fixture is loaded, mutated in memory, written to
  `.local-test-data/runs/<label>/`, and the fixture file itself is left alone.
- `--label <name>` — name for this run's output directory under
  `.local-test-data/runs/` (defaults to a timestamp).
- `--config <overrides.json>` — path to a JSON file of `TopicGenConfig`
  field overrides (see `lib/news-harness/core/config.ts`), merged over the
  production defaults for this run only.

### `npm run test-news-harness-article-pipeline`

Runs the article relevance-scoring + reason-generation pipeline
(`lib/news-harness/article-pipeline/scoring.ts`) end-to-end: fetches article
candidates for the persona's fact-derived topics via the real GraphQL API,
scores them against the persona's facts using the real NEAR AI Cloud API, and
writes buckets/reasons to `.local-test-data/runs/<label>/`.

Flags:

- `--label <name>` — run output directory name (defaults to a timestamp).
- `--limit-per-topic <n>` — cap on articles fetched per topic (mirrors the
  production `limitPerTopic`, default from `ArticlePipelineConfig`).
- `--articles-from <runDir>` — instead of hitting `articleIdsForTopics` /
  `articlesForTopicsByIds` again, replay the exact article set captured in an
  earlier run's `scores.json`. **Use this whenever you're iterating on
  scoring config/prompts** — it keeps the article set identical across runs
  (so `harness:compare` diffs are meaningful) and avoids re-charging the
  server's daily per-user article-delivery quota (`articlesForTopicsByIds` is
  the same delivery point the production feed uses — every fresh fetch spends
  from that same cap).
- `--config <overrides.json>` — JSON file of `ArticlePipelineConfig` field
  overrides (chunk size, temperature, bucket cutoffs, etc.), merged over the
  production defaults for this run only.

### `npm run harness:compare -- <runDirA> <runDirB>`

Diffs two run directories under `.local-test-data/runs/`: config changes,
summary-stat deltas, a bucket-transition matrix (including the `DISCARD`
bucket as a first-class row/col, so every article appears in exactly one
cell), kept↔discarded flips (derived from each run's own `kept` field, or
`rawScore >= discardFloor` as a fallback), the top 10 biggest raw-score
movers, and articles unique to either run. Warns loudly if the two runs
don't share the same article set — pair it with `--articles-from` on the
second run for an apples-to-apples comparison.

## Run-directory contents

Each run writes to `.local-test-data/runs/<label>/`:

- `config.json` — the effective config (defaults ± your `--config`
  overrides) used for that run.
- `summary.json` — aggregate stats (counts per bucket, timings, call counts).
- `scores.json` — per-article `{ id, title, rawScore, relevance, reason }`.
- Prompt/response dumps per LLM call (see the script's own `--help` /
  in-repo docs for the exact per-run file layout).

## The iterate loop

1. **Baseline run**: `npm run test-news-harness-article-pipeline -- --label baseline`.
2. **Tweak** a prompt in `lib/news-harness/prompts/prompts.ts` or a config
   field via `--config overrides.json`.
3. **Replay** against the exact same articles:
   `npm run test-news-harness-article-pipeline -- --label tweak-1 --articles-from .local-test-data/runs/baseline`.
4. **Compare**: `npm run harness:compare -- .local-test-data/runs/baseline .local-test-data/runs/tweak-1`.
5. Repeat 2-4 until satisfied, then port the prompt/config change into the
   real production path (it already reads from the same
   `lib/news-harness/core/config.ts` / `lib/news-harness/prompts/prompts.ts`
   files, so there's nothing further to sync).

## Auth per target

Set `NEWS_HARNESS_TARGET` in `harness-local/.env.harness`:

- `local` (default) — no auth needed. mera-server's GraphQL service runs as a
  dev-user bypass whenever `NODE_ENV !== 'production'`.
- `staging` / `prod` — requires `NEWS_HARNESS_AUTH_ENDPOINT` and
  `NEWS_HARNESS_AUTH_EMAIL`. Runs the real Better Auth email-OTP flow (same
  one the app uses) on first run, prompts for the emailed OTP on the
  terminal, and caches the resulting session in
  `.local-test-data/.auth-cache.json` for ~6 days (Better Auth's default session
  length is 7 days) so you aren't re-authenticating on every invocation.

## Daily-quota note

`articlesForTopicsByIds` is the server's actual delivery point for the daily
per-user article cap — the same one the production For-You feed uses. Every
call against `staging`/`prod` with a fresh article-id set spends from that
cap. Prefer `--articles-from <earlier-run-dir>` whenever you're just
iterating on scoring/prompt config rather than testing fresh article
discovery — it replays the previously-fetched article set with zero
additional GraphQL calls to `articlesForTopicsByIds`.
