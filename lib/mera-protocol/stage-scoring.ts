// stage-scoring — the RN-coupled bridge that loads the on-device persona
// snapshot and routes scoring candidates through the ONE deterministic math +
// judge stage (scoring-engine/run-stage::computeAndJudge). Both scoring
// orchestrators build on this, so the math + judge behaviour cannot drift
// between them (the "no divergence" guarantee, Wave 7b M-P5).
//
//  - loadPersonaScoringContext(): reads topics/locations/pub-prefs/suppressions
//    + fact weights → the plain PersonaScoringContext + a topicId→weight map.
//  - buildStageCandidates(): maps ScoringCandidate[] (with their persisted
//    metadata columns) → StageCandidate[] the engine scores.
//  - computeAndJudgeForCandidates(): the sync inline path (LLM judge round-trip
//    happens inline via an LlmPort). The E2EE pipeline uses loadPersonaScoring
//    context + buildStageCandidates + the pure engine directly (its LLM call is
//    a deferred encrypted job), so both share the identical math + persona.

import { cloudBatchComplete, cloudComplete } from '@/lib/llm/cloudComplete';
import { completeLocal } from '@/lib/llm/completeLocal';
import { SMALL_MODEL } from '@/lib/llm/constants';
import { useMeraProtocolStore } from '@/lib/stores/mera-protocol-store';
import { ProcessingMode } from '@/lib/generated/graphql-types';
import type { LlmPort } from '@/lib/news-harness/core/ports';
import type { ScoringCandidate, StageCandidateRow } from '@/lib/news-harness/core/types';
import { DEFAULT_HARNESS_CONFIG, type HarnessConfig } from '@/lib/news-harness/core/config';
import { getScoringOverrides } from '@/lib/database/services/calibration-service';
import { appHarnessLogger } from '@/lib/news-harness-app/logger-adapter';
import {
  computeAndJudge,
  computeRelevance,
  applyScoringOverrides,
  buildPubPrefs,
  normalizeLocation,
  type StageCandidate,
  type StageResult,
  type PersonaScoringContext,
  type PersonaLocationSnapshot,
  type RelevanceComponents,
  type ScoringMode,
} from '@/lib/news-harness/scoring-engine';
import {
  buildStageCandidateInput,
  getFactWeightById,
  type TopicWeightInfo,
} from '@/lib/database/services/article-suggestion-service';
import { getFacts } from '@/lib/database/services/fact-service';
import { getActive as getActiveTopics } from '@/lib/database/services/topic-service';
import { getAll as getAllLocations } from '@/lib/database/services/location-service';
import { getActive as getActivePubPrefs } from '@/lib/database/services/publication-preference-service';
import { getActive as getActiveSuppressions } from '@/lib/database/services/suppression-service';
import { getOpenedSeenSet } from '@/lib/database/services/story-impression-service';

const clamp = (x: number, lo: number, hi: number): number =>
  x < lo ? lo : x > hi ? hi : x;

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
    pubPrefRows.map((p) => ({ publicationName: p.publicationName, weight: p.weight })),
  );

  // All active suppressions are treated as SOFT (score penalty, capped) here.
  // Hard-filter (strength ≥ 0.8) pre-filtering is a later wave; the engine's
  // P_SUP_CAP bounds the demotion regardless.
  const softSuppressions = suppressions.map((s) => ({
    keywords: s.keywords ?? [],
    strength: s.strength,
  }));

  const persona: PersonaScoringContext = {
    locations: personaLocations,
    pubPrefs,
    softSuppressions,
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
 *  input, the ScoringCandidate itself is the `legacy` backstop payload. */
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
 * Exported (Wave 14) so the E2EE scoring pipeline builds/decodes its judge
 * calls against the SAME effective config computeMathStage scored with —
 * previously it hardcoded DEFAULT_HARNESS_CONFIG there, which was safe only
 * because no judge-touched field is currently tunable.
 */
export async function effectiveHarnessConfig(): Promise<HarnessConfig> {
  try {
    const overrides = await getScoringOverrides();
    const eng = applyScoringOverrides(DEFAULT_HARNESS_CONFIG.scoringEngine, overrides);
    return eng === DEFAULT_HARNESS_CONFIG.scoringEngine
      ? DEFAULT_HARNESS_CONFIG
      : { ...DEFAULT_HARNESS_CONFIG, scoringEngine: eng };
  } catch {
    return DEFAULT_HARNESS_CONFIG;
  }
}

export interface MathStageResult {
  persona: PersonaScoringContext;
  stage: StageCandidate[];
  computedScoreMap: Map<string, number>;
  componentsMap: Map<string, RelevanceComponents>;
  modeMap: Map<string, ScoringMode>;
}

/**
 * Run ONLY the deterministic math (no LLM) over the candidates — used by the
 * E2EE pipeline at SUBMIT time. The judge round-trip is then deferred as an
 * encrypted job (buildJudgeCalls / decodeJudgeResults). Persist the computed
 * scores so a judge failure fail-opens to the math.
 */
export async function computeMathStage(
  candidates: ScoringCandidate[],
  nowMs: number = Date.now(),
): Promise<MathStageResult> {
  const [{ persona, topicWeights }, config] = await Promise.all([
    loadPersonaScoringContext(nowMs),
    effectiveHarnessConfig(),
  ]);
  const stage = buildStageCandidates(candidates, topicWeights);
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
  return { persona, stage, computedScoreMap, componentsMap, modeMap };
}

/**
 * Sync inline path: compute the math for every candidate, judge the math-mode
 * ones and legacy-score the backstop ones — one call. The judge LLM round-trip
 * happens INLINE via the LlmPort (this is the synchronous scoring-service
 * orchestrator; the E2EE pipeline defers the LLM call and so does NOT use this).
 */
export async function computeAndJudgeForCandidates(
  candidates: ScoringCandidate[],
  opts?: { skipJudge?: boolean; nowMs?: number },
): Promise<StageResult> {
  const [{ persona, topicWeights }, factStatements, config] = await Promise.all([
    loadPersonaScoringContext(opts?.nowMs),
    loadAllFactStatements(),
    effectiveHarnessConfig(),
  ]);
  const stage = buildStageCandidates(candidates, topicWeights);
  return computeAndJudge(stage, persona, getScoringLlmPort(), config, {
    nowMs: opts?.nowMs,
    factStatements,
    logger: appHarnessLogger,
    skipJudge: opts?.skipJudge,
  });
}
