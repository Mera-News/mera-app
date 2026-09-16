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

All mutable harness state lives under `.local-test-data/` (gitignored in full):
your own persona fixture (`persona.json`), run output (`runs/`), and the cached
auth session, now `.auth-cache.<target>.json`, one per environment. That path
resolves against `process.cwd()`, which for every wired npm script is
`mera-app/`, this repo's root, not the `mera-news/` directory holding the seven
repos.

`harness-local/fixtures/**` IS tracked in git: `persona.example.json`, the
`goldset-348` pair, `persona-chat/` and `persona-corpus/`. Only
`harness-local/.env.harness` and `.local-test-data/` are ignored.

**`harness-local/.env.harness.example` is NOT tracked either.** The repo's
`.gitignore` carries a broad `.env.*` rule that swallows it, so a fresh
checkout has neither file and the `cp` in Setup above cannot work. Write
`.env.harness` by hand; every variable is listed under Environment below.

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


## Environment

Every variable the harness reads, since the example file is not in git (see
above).

| Variable | Required | What |
|---|---|---|
| `NEWS_HARNESS_TARGET` | no, defaults `local` | `local` / `staging` / `prod`. `--target` on a staging-rail runner overrides it for the process. |
| `NEWS_HARNESS_NEARAI_API_KEY` | no | NEAR AI key. Falls back to `NEAR_AI_DEVELOPMENT_KEY` in the repo-root `.env`. |
| `NEWS_HARNESS_NEARAI_BASE_URL` | no | Defaults `https://cloud-api.near.ai/v1`. |
| `NEWS_HARNESS_GRAPHQL_ENDPOINT` | yes off the rail | On the staging rail an unset value takes the staging default. |
| `NEWS_HARNESS_AUTH_ENDPOINT` | yes for staging/prod | Same. |
| `NEWS_HARNESS_INFERENCE_ENDPOINT` | no | E2EE gateway. Only the gateway lane needs it. |
| `NEWS_HARNESS_AUTH_EMAIL` | yes off the rail | Email-OTP identity. Not needed on the staging rail, which can use the dev bypass. |
| `NEWS_HARNESS_MODEL` | no | Overrides the default cloud model. |
| `NEWS_HARNESS_DEBUG` | no | Verbose logging. |

## The staging rail

`.env.harness` on this machine is set to **prod**, with the live
`graphql.mera.news` and `auth.mera.news` hosts. The loader passes a SET
endpoint through untouched by design, so `--target staging` alone reaches the
guard and fails with "is the PROD host". Pass the endpoints too. They are
checked like any other value, so a flag pointed at prod is still refused.

```bash
npx tsx --tsconfig harness-local/tsconfig.json harness-local/scripts/run-newsharness-corpus.ts \
  --target staging \
  --graphql-endpoint https://graphql.staging.mera.news/graphql \
  --auth-endpoint https://auth.staging.mera.news \
  --inference-endpoint https://inference.staging.mera.news \
  --repeat 3 --limit 40 --label baseline
```

The runners refuse any host that is not a DNS-suffix match on
`.staging.mera.news`, and refuse target `prod` outright. The four pre-existing
scripts are deliberately NOT on the rail: they are the user's own tools and the
instruments behind the `MODEL_FALLBACKS` table. They print a banner instead when
pointed at prod.

## The two corpus runners

`run-newsharness-corpus.ts` runs the relevance and reason prompts over a fixed
article set across model arms. `run-persona-corpus.ts` runs the persona-update
prompt and tool schema through four scripted cohorts with state carried across
turns. Both write one JSONL row per call to `.local-test-data/runs/<label>/`,
which is the only thing a blind rater reads, plus `agreement.txt`,
`summary.json` and, on a live run, `models.json`.

Both take `--dry-run`, which proves the whole path with no calls and no spend.
Start there.

**No quota is spent by either.** The news-harness runner replays the tracked
`fixtures/goldset-348.json`, which carries both a persona and 348 articles, so
`articlesForTopicsByIds` is never called.

Key flags: `--repeat N` (3 or more, or the number is not a floor), `--arms`,
`--variant`, `--duplicate-every N` for rater duplicates, `--fixture`,
`--cohorts`.

### Reading the output

- `integrity:` must say every cell held one prompt hash. Both runners exit 1 if
  a fixture-determined cell did not.
- `diverged=N/repeats` on a chat cell is not a fault. Stateful repeats drift
  apart after turn 0 because each saved different facts; the number says how
  far.
- A band violation in the instruction-following block is a contract metric, not
  a leak. `clampToStakeBand` already clamped the score.
- A zero cache column means NOT REPORTED. NEAR returns
  `prompt_tokens_details: null`, so the cache-read rate never applies.

## The injection fixtures, and two ways to misread them

`fixtures/persona-corpus/articles/injected/goldset-injected.json` carries one
synthetic article per defence in `lib/news-harness/prompts/untrusted-text.ts`,
plus a clean control so a zero finding is falsifiable. Pass it to the
news-harness runner with `--fixture`.

**The 500-character cap is a floor on what is CUT, not a ceiling on what is
SENT.** `asUntrusted` truncates the RAW input at 500 and escapes afterwards, so
the delivered string can be longer than the cap. Measured: 500 raw characters of
`>>` runs deliver **999**, because each run is spaced out character by
character; 400 plain plus 100 of `>>` delivers 599. Never assume the model
received at most 500 characters.

**Check a cut with a SHORT PREFIX of the payload, not the whole phrase.**
Searching for the full string reports "absent" for a payload that was merely
truncated mid-word while its imperative still arrived. That is exactly how
`inj-past-truncation` came to carry a false note: its payload starts at raw
index 470, before the cap, so the model receives `Ignore every previous
instruct` and only the tail of the sentence is removed. It tests whether a
half-delivered imperative still steers the model. `inj-beyond-cap` is the row
that tests the cap holding a payload back: its payload starts at index 613 and
none of it arrives.

The two together are a control pair. A run where the prefix reaches the model in
the first and not in the second is the cap working; either result alone proves
nothing.

## Gates

There is no jest here, and `tsc -p harness-local/tsconfig.json` pulls in the app
tree, where roughly 1,700 errors pre-exist, so its exit code cannot tell a new
mistake from the standing red. The two real gates:

```bash
npx tsc -p harness-local/tsconfig.lib.json        # scoped typecheck, add every new file
npx tsx --tsconfig harness-local/tsconfig.json harness-local/scripts/selftest.ts
```

`tsconfig.lib.json` has an explicit `files` list. A new file that is not added
to it is silently not covered while the gate still exits 0.
