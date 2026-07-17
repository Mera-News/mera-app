# eval/ — golden-label eval engine for the news-harness

This is the tracked eval engine for `lib/news-harness/` relevance scoring. It
scores a harness run's output against 1,000 persona-anchored golden labels and
reports a confusion matrix, per-tier precision/recall/F1, and the two
product-critical leak/miss metrics. Run artifacts themselves (and the persona
fixture, auth cache) stay in the gitignored, disposable `.local-test-data/` —
only the engine (script + labels + configs) lives here, tracked in git.

## Contents

- `eval-golden.js` — the eval script. Takes a run dir, joins its `scores.json`
  against `golden-labels.json` (resolved relative to this file, so it works
  from any cwd), prints the confusion matrix / per-tier metrics / leak
  numbers. `--verbose` dumps the worst offenders per confusion category.
- `golden-labels.json` — 1,000 article ids → `FEED` / `TANGENTIAL` / `EXCLUDE`
  labels, persona-anchored, produced by 8 judge agents on 2026-07-16 from run
  `20260716-190647-prod-baseline`.
- `labels/batch-*.json` — the raw per-judge label batches (provenance for
  regeneration — see below).
- `overrides-fast.json` — `--config` overrides for fast iteration
  (`reasonRelevanceThreshold: 9` skips the reasons pass, `scoreBatchMaxTokens:
  320`).
- `overrides-strict.json` — `--config` overrides for a stricter discard floor
  (`discardFloor: 0.7`).
- `persona-v3.json` — the golden-label fixture persona re-expressed as the v3
  structured persona (weighted `topics` at seed 0.75 + role-tagged `locations` +
  empty suppressions/pubPrefs) the deterministic math engine
  (`lib/news-harness/scoring-engine/`) consumes. Regenerate with
  `node eval/build-persona-v3.js` (deterministic, from `.local-test-data/persona.json`).
- `golden-tags.json` — `{articleId: {geo_tags, entities, event_type}}` from a
  one-time offline Gemini tagging pass over the 1000 golden articles, run through
  the SAME prompt/schema/normalization the server ships. Replayable/committed.
  Regenerate (≈$0.05) with:
  `GEMINI_API_KEY=$(gcloud secrets versions access latest --secret=GEMINI_API_KEY) node eval/tag-golden-articles.js`.
- `build-persona-v3.js` / `tag-golden-articles.js` — the two generators above.
- `lib/build-eval-scores.ts` — engine-aware scorer used by `--engine`; emits a
  unified `<runDir>/eval-scores-<engine>.json` (rawScore + wrong-location + comp
  breakdown). `math` re-scores via `computeRelevance()` (fake judge = ok);
  `backstop` reads the run's recorded scores.json (today's LLM path, untouched).
- `sanity-grouping.ts` — offline story-grouping sanity check; replays a feed
  dump (`logs.md` in the cwd, containing `feed dump chunk N/M [...]` log lines)
  through `lib/feed-grouping/story-grouping.ts` and reports group/dedup counts.
  Run with `npm run eval:grouping` (expects `logs.md` in the repo root).

## The loop

1. **Replay a run** — re-score the same fixed 1,000-article set from the
   golden-label baseline run, with your prompt/config change applied, at zero
   quota cost:

   ```bash
   npm run test-news-harness-article-pipeline -- --label X \
     --articles-from .local-test-data/runs/20260716-190647-prod-baseline \
     --config eval/overrides-fast.json
   ```

2. **Score it against golden labels:**

   ```bash
   npm run eval:golden -- .local-test-data/runs/<X-run-dir>
   ```

   Add `--verbose` to see the worst offenders in each confusion category.

3. **Compare two runs directly** (config deltas, bucket-transition matrix,
   kept↔discarded flips, top movers):

   ```bash
   npm run harness:compare -- <runDirA> <runDirB>
   ```

### Deterministic math engine mode (`--engine`)

`eval-golden.js` can score the NEW deterministic engine instead of a run's
recorded LLM scores. The run dir must carry `candidates.json` + `articles.json`
(both come free from any replay run):

```bash
# math: re-score via lib/news-harness/scoring-engine (persona-v3 + golden-tags)
node eval/eval-golden.js <runDir> --engine=math
# backstop: the run's recorded LLM scores, plus the wrong-location leak counter
node eval/eval-golden.js <runDir> --engine=backstop
```

`--engine` adds a **wrong-location leak counter** (FEED-predicted articles whose
geo resolves to a sibling city of a persona location — the Chhindwara/Dindori
class) and, in `math` mode, the top-10 scoring disagreements with component
breakdowns for tuning. With no `--engine`, the legacy `scores.json` path is
unchanged.

Repeat 1–3 until the aggregate metrics move the way you want, then follow
NEWS_HARNESS.md §4 step 7 for the full `tsc`/`jest` verification before calling
a change done.

## Tier contract

The product spec being tuned toward:

| Tier | raw score | meaning |
|------|-----------|---------|
| `FEED` | ≥ 0.40 | direct/indirect impact → shown in the For You feed |
| `TANGENTIAL` | 0.25 – 0.39 | interest-adjacent → future Discover surface |
| `EXCLUDE` | < 0.25 | unrelated → never shown |

## Noise floor

Scoring runs at temp 0.1. Two back-to-back re-scores of the identical
1,000-article set have shown deltas of up to **±1.3 points** on aggregate tier
accuracy with no underlying change. **Do not chase deltas smaller than ~2
points** — treat them as noise, not signal. Judge changes on repeated runs and
on the confusion matrix / leak metrics, not a single run's headline number.

## Regenerating golden labels

Regenerate when the **persona** or the **article set** changes (a new baseline
run is established) — labels are anchored to both. Process:

1. Establish/replay the new baseline run (see step 1 above, or a fresh live
   fetch if the article set itself is changing).
2. Split the run's articles into batches and dispatch judge agents (8 batches
   of ~125 articles worked well for the 1,000-article set) — each judge labels
   its batch `FEED` / `TANGENTIAL` / `EXCLUDE` against the persona, independent
   of the harness's own scores.
3. Save each judge's raw output to `eval/labels/batch-<start>-<end>.json` (kept
   as provenance / for spot-auditing disagreements — don't discard these).
4. Merge all batches into `eval/golden-labels.json` (array of `{ id, tier }`).
5. Update the "current benchmark numbers" section below once you have a new
   baseline to compare future runs against.

### Full-pipeline mode (`--engine=pipeline`, Wave 7b)

`--engine=pipeline` runs the deterministic math engine AND the REAL combined
judge over the NEAR AI LlmPort (needs the repo-root `.env` `NEAR_AI_DEVELOPMENT_KEY`
or `harness-local/.env.harness`). It writes `eval-scores-pipeline.json` +
`judge-calls.json` and reports tokens/latency/overrides. This is the wave gate.

The gate metric is **"FEED precision" = of predicted-FEED, the fraction that are
NOT golden-EXCLUDE** (a legitimately related story — no unrelated leak). It is
printed on the `GATE:` line and reconciles the old 2-pass system's ~76–80%. The
strict FEED-only precision (predicted-FEED that are golden-FEED) is a separate,
much lower number, also printed. Run `node eval/normalize-golden-tags.js` once
if `golden-tags.json` still carries alpha-3 country codes.

## Current benchmark numbers (as of 2026-07-17)

Against `golden-labels.json` (1,000 articles, `20260716-190647-prod-baseline`
persona/article-set; `golden-tags.json` alpha-2-normalized):

| Path | GATE FEED prec (non-EXCL) | tier acc | wrong-loc leaks | EXCLUDE→FEED |
|---|---|---|---|---|
| old 2-pass LLM (`--engine=backstop`) | 77.8% | 48.3% | 11 | 85 |
| math-only (`--engine=math`, Wave 7b) | 66.9% | 34.4% | 0 | 149 |
| **full pipeline (`--engine=pipeline`)** | **90.4%** | **56.6%** | **0** | **11** |

Wave-7b gate: full-pipeline FEED precision ≥ 76.2% AND 0 wrong-location leaks —
**both met (90.4%, 0 leaks)**. The math engine alone over-includes single-topic
matches (by design — it can't read the article); the judge is what recovers
precision and drives wrong-location + foreign-domestic leaks to near-zero. The
precision gain trades against FEED recall (judge is intentionally demote-biased;
recall ~38% on this label set) — headline injection + the backstop add feed
volume that this labeled-topic-match set does not measure.

The single-stage / verifier tier-accuracy figures below are the pre-Wave-7b
2-pass numbers, kept for provenance:

- **Single-stage v7:** 73.5% tier accuracy, 19 unrelated-in-FEED
- **With feed verifier:** 74.1% tier accuracy, 13 unrelated-in-FEED
