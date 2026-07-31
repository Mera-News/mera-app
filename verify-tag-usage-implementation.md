# Verifying tag-based scoring against LLM-only scoring

How to run the comparison, what has to be true first, and what result would
justify turning article enrichment on in production.

Written 2026-07-30. Everything marked **verified** was checked directly and the
check is named; everything else is flagged as an assumption.

---

## 1. What the two arms actually are

**Arm A — what every user runs today.** `isBackstop()`
([relevance.ts](lib/news-harness/scoring-engine/relevance.ts)) returns true when
an article has no geo tags, no entities and no event type:

```ts
(candidate.geoTags?.length ?? 0) === 0 &&
(candidate.entities?.length ?? 0) === 0 &&
!candidate.eventType
```

It tests **emptiness, not presence** — verified — so production's schema-default
empty arrays correctly read as "untagged". Since enrichment has never run in
production, this is true for **every article**, and every article is scored by
the legacy two-pass LLM path. The deterministic math engine has never scored a
real article for a real user.

**Arm B — tag-based.** With those three columns populated, the article routes to
`computeRelevance`, which adds geo / entity / event-type components and enables
**structured** suppression matching (`kind: category | event_type | entity |
place | topic`) instead of keyword-substring matching alone.

**The switch.** `EXPO_PUBLIC_USE_ARTICLE_TAGS === 'true'`
([endpoints.ts](lib/config/endpoints.ts)) → `ScoringEngineConfig.USE_ARTICLE_TAGS`.
It fails **closed** on a typo, and it defaults to explicit `false`.

**Where it gates, and why that matters.** The flag gates the **data** at
`buildStageCandidates`, not `isBackstop`. That is deliberate: three separate
behaviours key off those columns — routing, the geo/entity/event scoring
components, and suppression matching. Gating only the router would have left the
other two live and made the two arms incomparable.

---

## 2. Preconditions — read before running anything

The comparison is currently **blocked in-app**. Three facts, all verified:

1. **Staging ingestion is off.** `sync-news-staging`, `cluster-news-staging` and
   `link-topics-staging` are all `PAUSED` (verified: `gcloud scheduler jobs list
   --location=europe-west1`). This is the deliberate staging cost posture, not a
   fault.
2. **The staging corpus is frozen.** Newest `pubDate` in `mera-staging` is
   **2026-07-20**; 266,952 articles total (verified by query).
3. **The app drops anything older than 48h.** `FEED_WINDOW_MS`
   ([fact-rows-selector.ts:94](lib/stores/fact-rows-selector.ts#L94)) is applied
   against `pubDate` in `feed-list-selector`, `fact-rows-selector` and
   `feed-diagnostics`.

⇒ Every backfilled article is 10+ days old and is filtered out before render.
**Tag the entire corpus and a staging user still sees an empty feed.** Fixing
the tagging does not fix this; only fresh articles or an off-app harness does.

### Corpus composition — required to interpret any result

From the 47,000-article backfill (50,189 tagged in total):

| | |
|---|---|
| empty `entities` | **21.9%** |
| empty `geo_tags` | **31.6%** |
| fully degraded (empty + empty + `other`) | **3.5%** |

The 3.5% are indistinguishable from untagged and **will route to the LLM path
even in arm B**. Without these three numbers in hand, a coverage gap will look
like a scoring-logic difference.

Also: **`category` is never populated on articles at all.** The `news-article`
document has no `category` field (confirmed by inspecting the document key set;
a direct `countDocuments` timed out, so treat this as strong-but-not-exhaustive).
The article `category` in GraphQL is *not* `publicationSource.category` — see the
comment at [article-service.ts:66](lib/article-service.ts#L66). Consequence: the
`category` suppression kind cannot match anything in **either** arm, so exclude
it from the comparison rather than reading it as an arm-B failure.

### Two ways to unblock

- **On-device (what the original request implies).** Unpause `sync-news-staging`
  with pre-processing enabled so fresh articles arrive already tagged. Costs
  staging money; the backfilled corpus then serves as vector-search depth.
- **Off-app.** Run both arms over a captured run dir where `nowMs` is pinned by
  the fixture rather than by wall clock. Cheaper, fully reproducible, but it
  does not exercise the real feed pipeline.

---

## 3. The methodology point that decides whether this is worth anything

**LLM scoring is nondeterministic.** `NEWS_HARNESS.md` (lines ~341–347) records
**~36 kept↔discarded flips and ±0.55 score swings replaying an unchanged
codebase** at temperature 0.1/0.2.

So:

> **Run arm A against itself, n≥3 times, and establish its noise floor BEFORE
> comparing arm A to arm B. Any A-vs-B difference smaller than the A-vs-A
> variance is not a finding.**

Skipping this is the single most likely way to reach a confident wrong
conclusion. Arm B is deterministic (`computeRelevance` is pure, `nowMs` pinned by
the run dir), so its variance is zero by construction — which makes it very easy
to mistake arm A's noise for arm B's signal.

---

## 4. Execution

### 4a. Arm B, deterministic, no network, no LLM key

```bash
cd mera-app
npm run eval:golden -- .local-test-data/runs/<runDir> --engine=math
# writes <runDir>/eval-scores-math.json
```

⚠️ **That output path is fixed and a re-run clobbers it.** Always `cp` each
result aside under a name the script never writes, before the next run.

Use `--persona <path>` to swap personas. `eval/persona-v3-suppress.json` has
strengths straddling the 0.8 hard cut-off if you want suppression behaviour in
scope.

### 4b. Arm A noise floor

Replay the same articles through the LLM path ≥3 times and diff the runs against
each other. `harness:compare` with `--articles-from` is the existing tool. Record
the spread — that number is the significance threshold for everything in §5.

### 4c. On-device A/B

1. Unpause `sync-news-staging`; confirm pre-processing is enabled so new
   articles arrive tagged.
2. Wait for the 48h window to fill with tagged articles.
3. Build with `EXPO_PUBLIC_USE_ARTICLE_TAGS=false`, capture the feed +
   Observability funnel.
4. Rebuild with `=true`, same account, capture again.
5. The math-vs-LLM funnel readout shows which path each article took — use it to
   confirm the flag actually changed routing, rather than assuming it did.

---

## 5. What to measure

| Metric | Why | Threshold |
|---|---|---|
| Top-N overlap (N = one screenful, ~10) | The only thing the user perceives | Must exceed arm A's self-overlap from §4b |
| Rank correlation over the shared set | Catches reordering that overlap hides | Same |
| Score distribution per arm | Reveals compression toward the middle | Qualitative |
| Disagreement cases | Where the arms diverge, **and which is right** | Read them; this is the real answer |
| Cost per 1,000 scored | Arm B's whole economic case | See §6 |
| Latency to first scored card | Math is local; LLM is a round trip | Qualitative |

**Weight the disagreement reading most heavily.** A high correlation with the
disagreements all falling the wrong way is a worse result than a mediocre
correlation with sensible disagreements. Pull ~20 divergent articles and judge
them by hand.

---

## 6. Cost, and the decision

Measured over 47,000 real articles, not estimated:

| | |
|---|---|
| blended | **$0.0556 / 1,000 articles** |
| observed range | $0.0451 – $0.0807 |
| original estimate | $0.0360 (**1.54× low**) |
| projected | **~$20–33/month** at 12–20k served/day |

Cost is a function of **article text length** (~0.33 input-tokens/char, stable
across runs), so a flat per-1,000 constant is the wrong shape of answer — that is
exactly how the original estimate went wrong. Re-derive for a different corpus.
Output tokens are priced 4× input and drive 65–73% of the bill.

**Enable enrichment in production if** arm B's top-N overlap beats arm A's own
run-to-run overlap, **and** hand-reading the disagreements favours arm B, **and**
~$20–33/month is acceptable for the latency and determinism gained.

**Do not enable on cost or latency alone.** Arm B is cheaper and faster
regardless; that was never in question. The only question is whether it is *as
good or better*, and only §5's disagreement reading answers it.

### Blocker if you decide yes

**No `pre-process-articles-fanout` Cloud Scheduler job exists** in
`mera-infra/cloud-scheduler.tf` **or** `staging/cloud-scheduler.tf`, though the
processor ships on server `main` and is wired into `async.module.ts`. Enrichment
will never run on a schedule until that cron lands — this is the same pattern
that left the original `tag-articles-fanout` dormant (its commit message said
*"Dormant until the :40 tag-articles-fanout cron lands in mera-infra"*; it never
did). Backfill is a manual command that exists only on server `dev`.

---

## 7. Traps

- **Sub-`MIN_DISPATCH` defer looks exactly like "the flag did nothing."**
  `MIN_DISPATCH = 5`; a smaller chunk waits up to 30 minutes. Grep for
  `gate: … enqueued N` first — **`enqueued 0` is inconclusive, not a result.**
- **Feed hydrates once per process.** Changes may need `close` → `open`;
  pull-to-refresh only reorders. `close` + `open` does **not** restart the
  process — use `simctl terminate`.
- **Don't use `eval:golden` as a gate on anything LLM-side.** It scores the math
  path only, and asserts nothing about arm A.
- **Headline rows are exempt from hard filters** (`isHardFilterExempt`, keyed on
  `headlineScope != null`) but **are** still demoted, floored at
  `HEADLINE_BASE_FLOOR`. Don't read an un-purged headline as a filter failure.
- **Don't compare against a stale baseline artifact.** The
  `eval-scores-math.json` in `20260716-190647-prod-baseline/` was written at an
  older sha and has an older column shape.
