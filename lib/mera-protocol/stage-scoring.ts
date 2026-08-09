// stage-scoring — the RN-coupled bridge that loads the on-device persona
// snapshot and routes scoring candidates through the ONE scoring stage
// (scoring-engine/run-stage::computeAndScore). Both scoring orchestrators build
// on this, so the hard screen + math behaviour cannot drift between them (the
// "no divergence" guarantee).
//
//  - loadPersonaScoringContext(): reads topics/locations/pub-prefs/suppressions
//    + fact weights → the plain PersonaScoringContext + a topicId→weight map.
//  - buildStageCandidates(): maps ScoringCandidate[] (with their persisted
//    metadata columns) → StageCandidate[] the engine scores.
//  - computeAndScoreForCandidates(): the sync inline path (the LLM round-trip
//    happens inline via an LlmPort). The E2EE pipeline uses
//    loadPersonaScoringContext + buildStageCandidates + the pure engine directly
//    (its LLM call is a deferred encrypted job), so both share the identical
//    hard screen, math and persona.

import { cloudBatchComplete, cloudComplete } from '@/lib/llm/cloudComplete';
import { completeLocal } from '@/lib/llm/completeLocal';
import { SMALL_MODEL } from '@/lib/llm/constants';
import { useMeraProtocolStore } from '@/lib/stores/mera-protocol-store';
import { ProcessingMode } from '@/lib/generated/graphql-types';
import type { LlmPort } from '@/lib/news-harness/core/ports';
import type { ScoringCandidate, StageCandidateRow } from '@/lib/news-harness/core/types';
import {
  DEFAULT_HARNESS_CONFIG,
  type HarnessConfig,
  type ScoringEngineConfig,
} from '@/lib/news-harness/core/config';
import { getScoringOverrides } from '@/lib/database/services/calibration-service';
import { appHarnessLogger } from '@/lib/news-harness-app/logger-adapter';
import {
  computeAndScore,
  computeRelevance,
  applyScoringOverrides,
  buildPubPrefs,
  normalizeLocation,
  normText,
  screenHardSuppressionsDetailed,
  type StageCandidate,
  type StageResult,
  type PersonaScoringContext,
  type PersonaLocationSnapshot,
  type RelevanceComponents,
  type ScoringMode,
  type SoftSuppression,
} from '@/lib/news-harness/scoring-engine';
import {
  buildStageCandidateInput,
  getFactWeightById,
  type TopicWeightInfo,
} from '@/lib/database/services/article-suggestion-service';
import { getFacts } from '@/lib/database/services/fact-service';
import { getActive as getActiveTopics } from '@/lib/database/services/topic-service';
import { getAll as getAllLocations } from '@/lib/database/services/location-service';
// source-pref v47 (D2/D6): this reads ALL active rows, including the live SCOPE
// rows (`scope_kind='country'`) whose `publication_name` is a human label
// ("India"), not a publication. A scope is a render-time preference and must
// never reach `pubPrefs` (a W_PUB score term keyed by publication name) or the
// muted-publication hard-filter derivation below — either would silently match a
// real publication that happens to share the label. Both consumers below skip
// `scopeKind != null` rows explicitly, which is deliberately where the filtering
// lives: a narrower `getActiveNamedPublications()` import would put the guarantee
// somewhere the two call sites can't show it, and each of them needs to be
// independently correct anyway.
import { getActive as getActivePubPrefs } from '@/lib/database/services/publication-preference-service';
import {
  getActive as getActiveSuppressions,
  kindOf,
  HARD_SUPPRESSION_STRENGTH,
} from '@/lib/database/services/suppression-service';
import { getOpenedSeenSet } from '@/lib/database/services/story-impression-service';

const clamp = (x: number, lo: number, hi: number): number =>
  x < lo ? lo : x > hi ? hi : x;

/** Publication-preference weight at or below which the publication counts as
 *  MUTED and is synthesized into a hard filter (D4). Explicit "never show me
 *  this source" writes -1; the small margin absorbs float drift. */
const MUTED_PUBLICATION_WEIGHT = -0.9;

const isOnDeviceMode = () =>
  useMeraProtocolStore.getState().processingMode === ProcessingMode.OnDevice;

// --- LlmPort adapters (for the inline sync path) ---------------------------

const cloudLlmPort: LlmPort = {
  batchComplete: (calls, opts) => cloudBatchComplete(calls, opts?.model),
  complete: (req) => cloudComplete(req),
};

/** Local (on-device) port: fan the batch out to sequential completeLocal calls,
 *  swallowing per-call errors into the BatchCompletionResult.error channel so
 *  the engine's fail-open (math stands) still applies. */
const localLlmPort: LlmPort = {
  batchComplete: (calls) =>
    Promise.all(
      calls.map(async (c) => {
        try {
          const output = await completeLocal({
            systemPrompt: c.system,
            prompt: c.prompt,
            maxTokens: c.maxTokens,
            temperature: c.temperature,
            responseFormat: 'json',
          });
          return { id: c.id, output };
        } catch (e) {
          return { id: c.id, output: '', error: e instanceof Error ? e.message : String(e) };
        }
      }),
    ),
  complete: (req) =>
    completeLocal({
      systemPrompt: req.systemPrompt,
      prompt: req.prompt,
      maxTokens: req.maxTokens,
      temperature: req.temperature,
      responseFormat: 'json',
    }),
};

export function getScoringLlmPort(): LlmPort {
  return isOnDeviceMode() ? localLlmPort : cloudLlmPort;
}

// --- Persona snapshot ------------------------------------------------------

export interface PersonaScoringSnapshot {
  persona: PersonaScoringContext;
  /** topicId → {effectiveWeight, highPriority, locationId}. */
  topicWeights: Map<string, TopicWeightInfo>;
}

/**
 * Load the on-device persona snapshot the math engine scores against:
 *   - topicWeights: active topics × fact-level weight, clamped to [-1,1].
 *   - locations: all non-expired locations (expired travel windows dropped).
 *   - pubPrefs / softSuppressions: explicit-only preferences.
 *   - hardSuppressions: the ≥ HARD_SUPPRESSION_STRENGTH "not interested"
 *     filters, PLUS a derived publication filter per muted source (D4).
 * NEVER leaves the device (privacy-lean).
 */
export async function loadPersonaScoringContext(
  nowMs: number = Date.now(),
): Promise<PersonaScoringSnapshot> {
  const [topics, locations, pubPrefRows, suppressions, factWeights, seenStoryIds] =
    await Promise.all([
      getActiveTopics(),
      getAllLocations(),
      getActivePubPrefs(),
      getActiveSuppressions(nowMs),
      getFactWeightById(),
      getOpenedSeenSet(),
    ]);

  const topicWeights = new Map<string, TopicWeightInfo>();
  for (const t of topics) {
    const factWeight = t.factId ? factWeights.get(t.factId) ?? 1 : 1;
    topicWeights.set(t.id, {
      effectiveWeight: clamp(t.weight * factWeight, -1, 1),
      highPriority: t.highPriority,
      locationId: t.locationId ?? undefined,
    });
  }

  const personaLocations: PersonaLocationSnapshot[] = locations
    .filter((l) => l.validUntil == null || l.validUntil > nowMs)
    .map((l) =>
      normalizeLocation({
        id: l.id,
        city: l.city ?? undefined,
        region: l.region ?? undefined,
        countryCode: l.countryCode,
        role: l.role,
        weight: l.weight,
        validUntilMs: l.validUntil ?? undefined,
      }),
    );

  const pubPrefs = buildPubPrefs(
    pubPrefRows.map((p) => ({
      publicationName: p.publicationName,
      weight: p.weight,
      scopeKind: p.scopeKind,
    })),
  );

  // Hard / soft partition — made HERE, exactly once, using the DB service's
  // HARD_SUPPRESSION_STRENGTH (0.8). Deliberately NOT a harness config
  // constant: the threshold is a property of how suppressions are stored, not a
  // tunable scoring weight.
  //   - soft (< 0.8) → capped score penalty (relevance.ts). UNCHANGED.
  //   - hard (≥ 0.8) → screened out entirely before any math/judge work.
  // `kind`/`value` are passed through as UNDEFINED when the column is null, so
  // the pure matcher owns the "null kind means keyword" default in one place.
  const softSuppressions: SoftSuppression[] = [];
  const hardSuppressions: SoftSuppression[] = [];
  for (const s of suppressions) {
    const isHard = s.strength >= HARD_SUPPRESSION_STRENGTH;
    const keywords = s.keywords ?? [];
    const pattern = s.pattern?.trim() || undefined;
    // A hard KEYWORD filter with no keywords would match nothing and silently
    // do nothing — fall back to its human pattern. Soft rows keep their exact
    // historical behaviour (empty keywords ⇒ no penalty), so this is hard-only.
    const effectiveKeywords =
      isHard && kindOf(s) === 'keyword' && keywords.length === 0 && pattern
        ? [pattern]
        : keywords;
    const entry: SoftSuppression = {
      keywords: effectiveKeywords,
      strength: s.strength,
      kind: s.kind ?? undefined,
      value: s.value ? normText(s.value) : undefined,
      pattern,
    };
    (isHard ? hardSuppressions : softSuppressions).push(entry);
  }

  // D4: a muted publication is a DERIVED hard filter, never a duplicated row.
  // The Sources preferences screen stays the single manager — un-muting lifts
  // the filter on the next load with nothing to clean up.
  for (const p of pubPrefRows) {
    // Defence in depth — the loader above already excludes scope rows. A scope
    // is never a hard filter: there is no "mute every Indian source" promise
    // here, and its label would match a real publication by name if it were.
    if (p.scopeKind != null) continue;
    if (p.weight > MUTED_PUBLICATION_WEIGHT) continue;
    const value = normText(p.publicationName);
    if (!value) continue;
    hardSuppressions.push({
      keywords: [],
      strength: 1,
      kind: 'publication',
      value,
      pattern: p.publicationName,
    });
  }

  const persona: PersonaScoringContext = {
    locations: personaLocations,
    pubPrefs,
    softSuppressions,
    hardSuppressions,
    // seen = OPENS ONLY (user decision): the P_SEEN demotion input is opened
    // rows exclusively — mere impressions never demote. Ids cover both
    // article_id and stable_cluster_id (the engine checks either).
    seenStoryIds,
    // entityInterest stays unset — deliberate (entity weights are a later
    // wave; entityComp reads 0 until an explicit "follow entity" signal exists).
  };

  return { persona, topicWeights };
}

// --- Stage candidate assembly ----------------------------------------------

/** Minimal StageCandidateRow for a candidate lacking persisted metadata (old
 *  rows / fallback path) → no geo/entities/event_type ⇒ backstop routing. */
function minimalStageRow(c: ScoringCandidate): StageCandidateRow {
  return {
    id: c.id,
    titleEn: c.titleEn,
    descriptionEn: c.descriptionEn,
    publicationName: null,
    countryCode: c.countryCode,
    firstPubDateMs: null,
    maxClusterSize: null,
    eventType: null,
    category: null,
    geoTagsJson: null,
    entitiesJson: null,
    matchedTopicsJson: null,
    headlineScope: null,
    stableClusterId: null,
  };
}

/** Map ScoringCandidate[] → StageCandidate[]: the rich metadata drives the math
 *  input, the ScoringCandidate itself is the `legacy` LLM-scoring payload.
 *
 *  THE ENGINE NOW SEES THE SERVER'S TAGS. `applyArticleTagPolicy` used to sit
 *  here and blank `geoTags` / `entities` / `eventType` unless
 *  `USE_ARTICLE_TAGS` was on. Both are deleted. The blanking was there to stop
 *  a tagged row routing onto the judge path; the judge is gone, so all it did
 *  was make the user's `event_type` / `entity` / `place` "not interested"
 *  filters — which the feedback surface CREATES — unable to match anything.
 *  See the header of `scoring-engine/relevance.ts` for what unblanking also
 *  turns on inside the math. */
export function buildStageCandidates(
  candidates: ScoringCandidate[],
  topicWeights: Map<string, TopicWeightInfo>,
): StageCandidate[] {
  return candidates.map((c) => ({
    input: buildStageCandidateInput(c.meta ?? minimalStageRow(c), topicWeights),
    legacy: c,
  }));
}

async function loadAllFactStatements(): Promise<string[]> {
  const facts = await getFacts();
  return facts
    .map((f) => f.statement)
    .filter((s) => typeof s === 'string' && s.trim().length > 0);
}

/**
 * M-P5c: layer the persisted `scoringEngineOverrides` (the self-tuning deltas the
 * calibration loop produced) over the base ScoringEngineConfig. Loaded once per
 * scoring batch. When there are no overrides, applyScoringOverrides returns the
 * SAME base reference, so we hand back DEFAULT_HARNESS_CONFIG untouched (no
 * allocation). Any read failure fail-opens to the base config.
 *

 * It is ALSO where the RUNTIME `relevanceV4` switch is layered in (the settings
 * toggle), for the same reason: `lib/news-harness/**` is RN-free and must never
 * import the store, and the calibration-overrides layer cannot carry a boolean
 * (`applyScoringOverrides` filters on a closed numeric allowlist and applies
 * `base × (1 + delta)`).
 *
 * v4 IS THE LEGACY PATH PLUS TWO MEASURED ARTICLE-TAG FEATURES, and it is
 * layered onto `articlePipeline`, NOT `scoringEngine`:
 *   - `legacyTagPromptEnabled` — the tag block in the pass-1 batch prompt;
 *   - `legacyTagReasonGateEnabled` — skip (and demote) pass-2 reason calls for
 *     the low-value event types.
 * ONE switch drives both: they were measured together and ship together.
 *
 * v4 moves the PROMPT only; the engine is untouched, so `scoringMode` is
 * bit-for-bit identical with the toggle on or off.
 *
 * (Retired: the relevanceV2 math-authoritative branch; the relevanceV3
 * single-pass two-axis scorer this toggle used to select; and the
 * `USE_ARTICLE_TAGS` gate, which was never part of v4 and is now deleted —
 * the engine always sees the server's tags.)
 *
 * The store read is INSIDE the try: a hydration/store failure fail-opens to
 * DEFAULT_HARNESS_CONFIG (v4 off), which is today's behaviour.
 */
export async function effectiveHarnessConfig(): Promise<HarnessConfig> {
  try {
    const relevanceV4 = useMeraProtocolStore.getState().relevanceV4 === true;
    // Fast path preserved: with the flag off this is DEFAULT_HARNESS_CONFIG
    // ITSELF, so a no-override read still returns that exact reference (identity
    // is asserted by stage-scoring.test.ts and relied on below). Only
    // `articlePipeline` is spread when it is on, so `base.scoringEngine` keeps
    // its identity either way and the `eng === base.scoringEngine` tail below
    // still short-circuits.
    const base: HarnessConfig = relevanceV4
      ? {
          ...DEFAULT_HARNESS_CONFIG,
          articlePipeline: {
            ...DEFAULT_HARNESS_CONFIG.articlePipeline,
            legacyTagPromptEnabled: true,
            legacyTagReasonGateEnabled: true,
          },
        }
      : DEFAULT_HARNESS_CONFIG;
    const overrides = await getScoringOverrides();
    const eng = applyScoringOverrides(base.scoringEngine, overrides);
    return eng === base.scoringEngine ? base : { ...base, scoringEngine: eng };
  } catch {
    return DEFAULT_HARNESS_CONFIG;
  }
}

export interface MathStageResult {
  persona: PersonaScoringContext;
  /** ACTIVE candidates only — hard-filtered ones are already removed. */
  stage: StageCandidate[];
  computedScoreMap: Map<string, number>;
  componentsMap: Map<string, RelevanceComponents>;
  modeMap: Map<string, ScoringMode>;
  /** Screened out by a hard "not interested" filter: absent from `stage` and
   *  from every map above. The caller persists these as terminal `excluded`. */
  excludedIds: Set<string>;
  /** excluded id → display value of the filter that matched it. */
  excludedValueById: Map<string, string>;
  /** P6. Top-headline ids that matched a hard filter but are EXEMPT from
   *  exclusion → that filter's display value. They ARE in `stage` and in every
   *  map above, scored and demoted; this is the label the card shows. */
  exemptedValueById: Map<string, string>;
}

/**
 * Run ONLY the deterministic math (no LLM) over the candidates — used by the
 * E2EE pipeline at SUBMIT time, whose LLM call is a deferred encrypted job.
 * Its real product is the HARD "not interested" screen plus the persisted
 * math/components audit; the scores fail-open if the LLM call never lands.
 */
export async function computeMathStage(
  candidates: ScoringCandidate[],
  nowMs: number = Date.now(),
): Promise<MathStageResult> {
  const [{ persona, topicWeights }, config] = await Promise.all([
    loadPersonaScoringContext(nowMs),
    effectiveHarnessConfig(),
  ]);
  const allStage = buildStageCandidates(candidates, topicWeights);

  // HARD "not interested" screen — the E2EE path never enters computeAndScore,
  // so this is its own convergence point for the same shared matcher. P6: a
  // top-headline row that matches a hard filter lands in `exempted`, stays in
  // `stage`, and is demoted by computeRelevance rather than removed.
  const { excluded: excludedValueById, exempted: exemptedValueById } =
    screenHardSuppressionsDetailed(
      allStage.map((c) => c.input),
      persona.hardSuppressions,
    );
  const excludedIds = new Set(excludedValueById.keys());
  const stage =
    excludedIds.size > 0
      ? allStage.filter((c) => !excludedIds.has(c.input.id))
      : allStage;

  const computedScoreMap = new Map<string, number>();
  const componentsMap = new Map<string, RelevanceComponents>();
  const modeMap = new Map<string, ScoringMode>();
  for (const c of stage) {
    const r = computeRelevance(
      c.input,
      persona,
      config.scoringEngine,
      nowMs,
    );
    computedScoreMap.set(c.input.id, r.score);
    componentsMap.set(c.input.id, r.components);
    modeMap.set(c.input.id, r.mode);
  }
  return {
    persona,
    stage,
    computedScoreMap,
    componentsMap,
    modeMap,
    excludedIds,
    excludedValueById,
    exemptedValueById,
  };
}

/**
 * Sync inline path: hard-screen, compute the math for every candidate, then
 * score them all through the legacy tiered LLM call. The LLM round-trip happens
 * INLINE via the LlmPort (this is the synchronous scoring-service orchestrator;
 * the E2EE pipeline defers the LLM call and so does NOT use this).
 */
export async function computeAndScoreForCandidates(
  candidates: ScoringCandidate[],
  opts?: { skipLlm?: boolean; nowMs?: number },
): Promise<StageResult> {
  const [{ persona, topicWeights }, factStatements, config] = await Promise.all([
    loadPersonaScoringContext(opts?.nowMs),
    loadAllFactStatements(),
    effectiveHarnessConfig(),
  ]);
  const stage = buildStageCandidates(candidates, topicWeights);
  return computeAndScore(stage, persona, getScoringLlmPort(), config, {
    nowMs: opts?.nowMs,
    factStatements,
    logger: appHarnessLogger,
    skipLlm: opts?.skipLlm,
  });
}
