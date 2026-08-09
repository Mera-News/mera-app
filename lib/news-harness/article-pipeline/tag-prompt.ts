// article-pipeline — server article-tag metadata on the LEGACY two-pass path.
//
// Two independent, independently-flagged features live here, both measured on
// `goldset-348` on 2026-08-08 (report: tag-salvage, Phases 1 and 2):
//
//   ADD 1  `legacyTagPromptEnabled`      — show the tags to the pass-1 prompt
//   ADD 2  `legacyTagReasonGateEnabled`  — a post-hoc demote gate that also
//                                          skips the row's pass-2 reason call
//
// WHY THIS FILE EXISTS SEPARATELY FROM `relevance.ts`
// ---------------------------------------------------------------------
// `relevance.ts` is the ENGINE: it consumes a `ScoredCandidateInput` and turns
// the same three tag columns into `geoComp` / `entityComp` / `eventComp` /
// `wrongLocPenalty` and into `mode`. What the v4 features here want is
// different — the tags as TEXT in the pass-1 prompt, and as a deterministic
// post-hoc reason gate — with the engine untouched either way.
//
// THE MECHANISM THAT KEEPS THE ENGINE UNAFFECTED (read this before editing)
// ---------------------------------------------------------------------
// The engine and prompt-building read two DIFFERENT objects derived from the
// same row, by two different functions:
//
//   engine : ScoringCandidate.meta ─► buildStageCandidateInput
//                                  ─► ScoredCandidateInput
//                                  ─► computeRelevance / isBackstop
//
//   prompt : ScoringCandidate      ─► buildScoreCallForChunk
//   + gate   (+ .meta, read HERE)  ─► articleMetadataLine / tag gate
//
// Everything in this file reads `ScoringCandidate.meta` directly and produces
// only STRINGS and ID LISTS. It never constructs a `ScoredCandidateInput` and is
// never called from `buildStageCandidates`, so nothing it does can reach
// `computeRelevance`. That separation is the whole point of the feature: it is
// what lets the v4 toggle move the PROMPT without moving the engine, and it is
// why the toggle stayed independent of the (now-deleted) `USE_ARTICLE_TAGS`
// gate. If a future edit makes this file produce an engine input, the flags stop
// being safe and the experiment behind them is void.
//
// Pure and RN-free, per the harness import discipline.

import type { ArticlePipelineConfig } from '../core/config';
import { DEFAULT_HARNESS_CONFIG } from '../core/config';
import type { ScoringCandidate, StageCandidateRow } from '../core/types';
import { supranationalName } from '../scoring-engine/supranational-codes';

const ARTICLE_CFG = DEFAULT_HARNESS_CONFIG.articlePipeline;

/** The prefix every injected line carries. Load-bearing: it is what
 *  {@link injectArticleMetadata}'s round-trip assertion strips back out, so it
 *  must never appear at the start of a line the shipped prompt itself emits. */
export const ARTICLE_METADATA_PREFIX = 'Article Metadata: ';

// --- parsing ----------------------------------------------------------------

/** Tolerant JSON-array parse. Mirrors `parseJsonArray` in
 *  `lib/database/services/article-suggestion-service.ts`, which is DB-layer and
 *  therefore un-importable from here. Any malformed value yields []. */
function parseJsonArray<T>(raw: string | null | undefined): T[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

interface RawGeoTag {
  city?: string;
  region?: string;
  countryCode?: string;
}

/**
 * The tag triple as the PROMPT should see it.
 *
 * Filtering is deliberately identical to `buildStageCandidateInput`'s — geo tags
 * without a non-empty `countryCode` are dropped, entities must be non-empty
 * strings — so the prompt can never describe a tag the engine would have
 * discarded, and vice versa.
 */
export function readCandidateTags(meta: StageCandidateRow | undefined): {
  geoTags: { city?: string; region?: string; countryCode: string }[];
  entities: string[];
  eventType: string | null;
} {
  if (!meta) return { geoTags: [], entities: [], eventType: null };
  const geoTags = parseJsonArray<RawGeoTag>(meta.geoTagsJson)
    .filter((g) => g && typeof g.countryCode === 'string' && g.countryCode.length > 0)
    .map((g) => ({
      city: g.city ?? undefined,
      region: g.region ?? undefined,
      countryCode: g.countryCode as string,
    }));
  const entities = parseJsonArray<string>(meta.entitiesJson).filter(
    (e): e is string => typeof e === 'string' && e.length > 0,
  );
  return { geoTags, entities, eventType: meta.eventType ?? null };
}

// --- ADD 1: the pass-1 prompt line ------------------------------------------

/**
 * One compact line of server metadata for a candidate, or '' when it carries
 * nothing worth saying.
 *
 * FORMAT IS FROZEN BY MEASUREMENT. This is byte-identical to the line the
 * 2026-08-08 A/B scored (`harness-local/scripts/score-v1-tagged.ts`), including
 * the fact that ' | ' separates BOTH the fields and the individual places. That
 * reads slightly ambiguously, and it is kept anyway: the measured +2.0..+3.7
 * must_show recall is a property of this exact string, and a "tidier" separator
 * is an unmeasured prompt change wearing a measured result's numbers.
 *
 *   Article Metadata: places: amsterdam, noord-holland, NL | entities: ING | event: business
 *
 * A SUPRANATIONAL geo tag ("MIDDLE_EAST", "EU", …) carries neither city nor
 * region — the server never emits one alongside a bloc/region code — so its
 * `countryCode` is rendered through {@link supranationalName} as prose
 * ("places: Middle East") rather than the raw SCREAMING_SNAKE token. A real
 * ISO alpha-2 country code is unaffected (`supranationalName` returns null
 * for it), so the frozen `places: amsterdam, noord-holland, NL` format above
 * is untouched.
 *
 * Omissions, each deliberate:
 *   - empty fields are dropped rather than sent as "none" — half this corpus is
 *     legitimately place-less and five "places: none" lines per chunk is noise;
 *   - `event_type: 'other'` is dropped, because it is the enum's mandatory
 *     fallback AND what the tagger's degrade path emits, so it is
 *     indistinguishable from a real classification.
 */
export function articleMetadataLine(candidate: ScoringCandidate): string {
  const { geoTags, entities, eventType } = readCandidateTags(candidate.meta);
  const parts: string[] = [];
  if (geoTags.length > 0) {
    const places = geoTags
      .map((g) =>
        [g.city, g.region, supranationalName(g.countryCode) ?? g.countryCode]
          .filter(Boolean)
          .join(', '),
      )
      .join(' | ');
    parts.push(`places: ${places}`);
  }
  if (entities.length > 0) parts.push(`entities: ${entities.join(', ')}`);
  if (eventType && eventType !== 'other') parts.push(`event: ${eventType}`);
  return parts.length === 0 ? '' : `${ARTICLE_METADATA_PREFIX}${parts.join(' | ')}`;
}

/** True when {@link articleMetadataLine} would say something for this row. */
export function carriesPromptableTags(candidate: ScoringCandidate): boolean {
  return articleMetadataLine(candidate).length > 0;
}

/**
 * Insert one metadata line per article block into an already-built pass-1 user
 * message, directly after that block's `Related User Fact:` line.
 *
 * WHY STRING SURGERY RATHER THAN A NEW FIELD ON THE PROMPT BUILDER. The block
 * format lives in `prompts/prompts.ts`, which is pinned by
 * `golden-prompts.test.ts` and is concurrently owned elsewhere. Appending here
 * keeps the shipped builder untouched, so with the flag OFF the emitted prompt
 * is the same object it always was — and the round-trip assertion below makes
 * "untouched" checkable rather than merely intended.
 *
 * THE ASSERTION IS THE POINT: deleting every injected line must reproduce
 * `input` byte-for-byte. Without it a drift in the block format would silently
 * turn this into "the shipped prompt plus whatever the surgery did", which is a
 * different experiment reporting a measured result's numbers. It throws rather
 * than falling back, because a silent fallback would be indistinguishable from
 * the flag being off.
 */
export function injectArticleMetadata(
  input: string,
  chunkCandidates: ScoringCandidate[],
): string {
  const out: string[] = [];
  let blockIndex = -1;
  for (const line of input.split('\n')) {
    out.push(line);
    if (/^===== Article \d+ =====$/.test(line)) blockIndex += 1;
    if (
      line.startsWith('Related User Fact: ') &&
      blockIndex >= 0 &&
      blockIndex < chunkCandidates.length
    ) {
      const meta = articleMetadataLine(chunkCandidates[blockIndex]);
      if (meta) out.push(meta);
    }
  }
  const injected = out.join('\n');
  const stripped = injected
    .split('\n')
    .filter((l) => !l.startsWith(ARTICLE_METADATA_PREFIX))
    .join('\n');
  if (stripped !== input) {
    throw new Error(
      'injectArticleMetadata: the injected prompt does not strip back to the input ' +
        'byte-for-byte — the article-block format has drifted. Refusing to emit a prompt ' +
        'that is no longer the measured one.',
    );
  }
  return injected;
}

// --- ADD 2: the post-hoc reason gate ----------------------------------------

/**
 * True when the candidate's `event_type` is in the configured low-value set.
 *
 * READ THE TWO CAVEATS AT `legacyTagReasonGateEventTypes` IN `core/config.ts`
 * BEFORE CHANGING THE SET. Short version: the set is PER-PERSONA, not a global
 * truth, and part of its measured value comes from a tagger bug.
 */
export function isTagReasonGated(
  candidate: ScoringCandidate,
  config: ArticlePipelineConfig = ARTICLE_CFG,
): boolean {
  if (!config.legacyTagReasonGateEnabled) return false;
  const eventType = candidate.meta?.eventType ?? null;
  if (!eventType) return false; // never-tagged rows are untouched
  return config.legacyTagReasonGateEventTypes.includes(eventType);
}

/**
 * The ids the gate removes from a reason subset, i.e. the rows whose pass-2
 * call is skipped and which must therefore be demoted out of the feed.
 *
 * NOTE ON "SKIP THE CALL" vs "DEMOTE". These are ONE action, not two. On this
 * path `reasonRelevanceThreshold` equals the render gate, so every
 * reason-eligible row is a row the user would see. Skipping its call without
 * moving its score would render it silently note-less — measured over 1,260
 * candidate rules, the maximum saving available that way is 0.0%. So the caller
 * MUST persist `feedVerifierDemoteScore` for every id returned here. Returning
 * the ids rather than writing them keeps this module pure; the write lives in
 * the orchestrators, exactly as `decodeV3NoteResults` / `applyV3NoteResults`
 * already split rules from persistence.
 *
 * NO HIGH-SCORE FLOOR EXISTS ON THIS PATH, AND NONE IS ADDED HERE. Neither the
 * legacy reason pass nor `applyV3NoteResults` protects a high-scoring row from
 * demotion — `decodeV3NoteResults` demotes whatever the model returned, at any
 * score. This gate matches that behaviour deliberately, because that is what was
 * measured: in the 2026-08-08 run the highest-scoring row it cut sat at 0.82
 * (judge verdict `skip`, j_comp 3.35). Across 7 independent scoring runs it lost
 * 0 of the panel's `must_show` rows and left recall-at-gate byte-identical, but
 * "0 of 25" bounds the true loss rate only at <= 12% (95%, rule of three) — it
 * does not prove zero. Adding a floor would be an UNMEASURED change to a
 * measured rule; if one is wanted, measure it first.
 */
export function selectTagGatedDemoteIds(
  candidates: ScoringCandidate[],
  config: ArticlePipelineConfig = ARTICLE_CFG,
): string[] {
  if (!config.legacyTagReasonGateEnabled) return [];
  return candidates.filter((c) => isTagReasonGated(c, config)).map((c) => c.id);
}
