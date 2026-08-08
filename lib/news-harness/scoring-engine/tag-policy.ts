// scoring-engine — the ONE place that decides whether server article-tagging
// metadata is honoured.
//
// Pure, RN-free. Reads `ScoringEngineConfig.USE_ARTICLE_TAGS` (bound from
// `EXPO_PUBLIC_USE_ARTICLE_TAGS` in the app's composition root) and nothing
// else — no `process.env` here, per the harness import discipline.
//
// WHAT THIS FLAG MEANS, NOW THAT THE JUDGE IS GONE
//
// One thing: DO "NOT INTERESTED" FILTERS MATCH ON AN ARTICLE'S PLACES, PEOPLE
// AND EVENT TYPE? Default `false` — they do not.
//
// It used to carry three meanings at once, because three engine behaviours key
// off the same three columns:
//
//   1. routing — `isBackstop` sent an untagged candidate down the legacy LLM
//      path and a tagged one to the judge. THE JUDGE IS DELETED; every candidate
//      takes the legacy path now, and `isBackstop` survives only as the producer
//      of the diagnostic `mode`. This meaning is gone.
//   2. scoring — `geoComp` / `entityComp` / `eventComp` (and `wrongLocPenalty`)
//      are computed from them. Still true, but it no longer decides what is
//      persisted as `relevance`: the LLM score does. It moves the math score,
//      which is the fail-open value and the audit trail.
//   3. suppression — `buildSuppressionHaystack` folds `entities` into the
//      keyword haystack, and the `entity` / `place` / `event_type` structured
//      kinds match on them, in BOTH the soft penalty and the hard screen. THIS
//      IS THE MEANING THAT REMAINS, and it is user-visible: it is the difference
//      between "not interested in Brussels" matching an article that merely
//      carries a Brussels geo tag, and matching only one that says so in its
//      text.
//
// Stripping the fields at the boundary makes OFF mean the engine never SEES a
// tag — one rule, no per-consumer branches to keep in sync.
//
// THIS IS NOT THE v4 FLAG, AND WAS DELIBERATELY NOT DELETED WITH v3 OR THE JUDGE.
//
// Both scorers this file was written alongside are retired. This gate is not:
// it is the reason those retirements did not change anybody's "not interested"
// filter. Three options were weighed — delete it, fold it into the v4 toggle, or
// keep it — and keeping it won on consumer (3) above. The hard screen runs on
// the legacy path (via `stage-scoring::computeMathStage` →
// `screenHardSuppressionsDetailed`), and `services/suppression-sweep.ts` calls
// `applyArticleTagPolicyAll` directly over rows ALREADY STORED on the device. So
// removing the strip would change what every existing filter matches,
// retroactively, on articles the user already has.
//
// Folding it into the v4 toggle was rejected separately: v4 is the legacy path
// plus two PROMPT features, and its flags live in `articlePipeline`, read inside
// the prompt builder (`article-pipeline/tag-prompt.ts`) where they cannot reach
// the engine at all. Wiring a scoring-prompt toggle to a suppression-matching
// policy would tie two unrelated user-visible behaviours to one switch.
//
// Pinned by `mera-protocol/__tests__/relevance-v4.test.ts` — its parity block
// fails if this strip is ever removed.
//
// Applied where a persisted row becomes a scoring candidate —
// `mera-protocol/stage-scoring::buildStageCandidates`, which BOTH scoring
// orchestrators (the sync inline path and the E2EE pipeline) build their inputs
// through. Doing it at that seam rather than inside `computeRelevance` keeps the
// pure engine's contract plain ("score what you are handed") and keeps the
// engine's own defaults — and therefore the offline eval in `eval/`, which
// drives it directly off `DEFAULT_HARNESS_CONFIG` and golden tag fixtures —
// exactly as they were.
//
// OUT OF SCOPE: `services/suppression-sweep.ts`, which re-screens ALREADY
// STORED rows against the user's "not interested" filters. That is filter
// application, not scoring, and its structured kinds are specified to read the
// tag columns. See the scope note in that file.

import type { ScoringEngineConfig } from '../core/config';
import type { ScoredCandidateInput } from './relevance';

/** True when the candidate carries none of the three tagging fields — i.e. the
 *  policy has nothing to strip. Deliberately the SAME triple `isBackstop`
 *  tests, so "untagged" means one thing in this codebase. */
function alreadyUntagged(input: ScoredCandidateInput): boolean {
  return (
    (input.geoTags?.length ?? 0) === 0 &&
    (input.entities?.length ?? 0) === 0 &&
    !input.eventType
  );
}

/**
 * Present `input` to the engine under the configured tagging policy.
 *
 * `USE_ARTICLE_TAGS: true`  → returned unchanged (same reference).
 * `USE_ARTICLE_TAGS: false` → a copy with `geoTags` / `entities` / `eventType`
 *                             cleared, so the engine treats it as never-tagged.
 *
 * Returns the SAME reference whenever nothing would change (policy on, or the
 * row is already untagged), so today's production path — where no article
 * carries any of these — allocates nothing and is byte-identical.
 *
 * `category` is deliberately NOT stripped, but NOT for the reason this comment
 * used to give. It claimed the field "is populated today" — it is not. The
 * `news-article` document carries no `category` at all, so no candidate ever
 * has one, and the `category` suppression kind is unmatchable on real data
 * regardless of this policy. (Do not confuse it with
 * `publicationSource.category`, which is the PUBLICATION's category and is a
 * different field — see the note at lib/article-service.ts:66.)
 *
 * The real reasons to leave it alone: it is not part of the untagged predicate,
 * and it is not produced by the tagging pipeline, so stripping it would be a
 * no-op that implies a relationship to tagging that does not exist.
 */
export function applyArticleTagPolicy(
  input: ScoredCandidateInput,
  cfg: ScoringEngineConfig,
): ScoredCandidateInput {
  if (cfg.USE_ARTICLE_TAGS) return input;
  if (alreadyUntagged(input)) return input;
  return { ...input, geoTags: [], entities: [], eventType: null };
}

/** Batch form of `applyArticleTagPolicy`. Returns the SAME array reference when
 *  the policy changes nothing, so the common path stays allocation-free. */
export function applyArticleTagPolicyAll(
  inputs: ScoredCandidateInput[],
  cfg: ScoringEngineConfig,
): ScoredCandidateInput[] {
  if (cfg.USE_ARTICLE_TAGS) return inputs;
  let changed = false;
  const next = inputs.map((i) => {
    const p = applyArticleTagPolicy(i, cfg);
    if (p !== i) changed = true;
    return p;
  });
  return changed ? next : inputs;
}
