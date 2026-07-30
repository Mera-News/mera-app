// Golden test: the old-path shim (lib/mera-protocol/scoring-service) and the
// harness must build byte-identical score/reason BatchCalls. Prompts are NOT
// mocked (real); only the shim's RN dependencies (LLM, DB, store, logger) are.

jest.mock('@/lib/llm/completeLocal', () => ({ completeLocal: jest.fn() }));
jest.mock('@/lib/database/services/calibration-service', () => ({
  recordOverrides: jest.fn().mockResolvedValue({ count: 0, notified: false }),
  getScoringOverrides: jest.fn().mockResolvedValue({}),
}));
jest.mock('@/lib/llm/cloudComplete', () => ({
  cloudComplete: jest.fn(),
  cloudBatchComplete: jest.fn(),
}));
jest.mock('@/lib/llm/constants', () => ({ SMALL_MODEL: 'test-small-model' }));
jest.mock('@/lib/logger', () => ({
  __esModule: true,
  default: {
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    info: jest.fn(),
    captureException: jest.fn(),
  },
}));
jest.mock('@/lib/database/services/article-suggestion-service', () => ({
  countUnscoredSuggestions: jest.fn(),
  getScoredSuggestionsWithoutReasons: jest.fn(),
  getUnscoredSuggestionsWithFacts: jest.fn(),
  saveReason: jest.fn(),
  saveScoringResult: jest.fn(),
}));
jest.mock('@/lib/database/services/fact-service', () => ({ getFacts: jest.fn() }));
// scoring-service now imports stage-scoring, which pulls in the persona DB
// services at load time; mock it so scoring-service loads without native deps.
jest.mock('@/lib/mera-protocol/stage-scoring', () => ({
  computeAndJudgeForCandidates: jest.fn(),
  computeMathStage: jest.fn(),
  loadPersonaScoringContext: jest.fn(),
  buildStageCandidates: jest.fn(),
  getScoringLlmPort: jest.fn(),
}));
jest.mock('@/lib/stores/mera-protocol-store', () => ({
  useMeraProtocolStore: { getState: jest.fn(() => ({ processingMode: 'CLOUD' })) },
}));
jest.mock('@/lib/generated/graphql-types', () => ({
  ProcessingMode: { Cloud: 'CLOUD', OnDevice: 'ON_DEVICE' },
}));

import {
  buildRelevanceCalls as shimBuildRelevanceCalls,
  buildReasonCallsForSubset as shimBuildReasonCallsForSubset,
} from '@/lib/mera-protocol/scoring-service';
import {
  buildRelevanceCalls as harnessBuildRelevanceCalls,
  buildReasonCallsForSubset as harnessBuildReasonCallsForSubset,
  buildScoreCallForChunk,
} from '../article-pipeline/scoring';
import {
  CLOUD_RELEVANCE_SYSTEM_PROMPT,
  CLOUD_REASON_SYSTEM_PROMPT,
  CLOUD_HEADLINE_RELEVANCE_SYSTEM_PROMPT,
  CLOUD_HEADLINE_REASON_SYSTEM_PROMPT,
} from '../prompts/prompts';
import { estimateTokens } from '@/lib/llm/tokens';
import { getFacts } from '@/lib/database/services/fact-service';
import type { ScoringCandidate } from '../core/types';

const mockGetFacts = getFacts as jest.MockedFunction<typeof getFacts>;

const FACT_STATEMENTS = ['Lives in Amsterdam, Netherlands', 'Works in AI'];

function candidate(id: string): ScoringCandidate {
  return {
    id,
    titleEn: `Title ${id}`,
    descriptionEn: `Description for ${id}`,
    countryCode: 'NLD',
    userTopicIds: [],
    relatedFacts: [{ id: `f-${id}`, statement: `related fact ${id}` }],
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockGetFacts.mockResolvedValue(
    FACT_STATEMENTS.map((statement) => ({ statement })) as never,
  );
});

describe('golden — buildRelevanceCalls', () => {
  it('shim and harness produce byte-identical score calls (incl. chunking)', async () => {
    const candidates = ['a', 'b', 'c', 'd', 'e', 'f'].map(candidate); // 6 → 2 chunks
    const shim = await shimBuildRelevanceCalls(candidates);
    const harness = harnessBuildRelevanceCalls(candidates, FACT_STATEMENTS);

    expect(shim.calls.map((c) => c.id)).toEqual(harness.calls.map((c) => c.id));
    expect(shim.calls.map((c) => c.system)).toEqual(harness.calls.map((c) => c.system));
    expect(shim.calls.map((c) => c.prompt)).toEqual(harness.calls.map((c) => c.prompt));
    expect(shim.calls.map((c) => c.temperature)).toEqual(
      harness.calls.map((c) => c.temperature),
    );
    expect(shim.calls.map((c) => c.maxTokens)).toEqual(
      harness.calls.map((c) => c.maxTokens),
    );
  });
});

describe('golden — buildReasonCallsForSubset', () => {
  it('shim and harness produce byte-identical reason calls', async () => {
    const candidates = [candidate('a'), candidate('b')];
    const relevanceMap = { a: 0.8, b: 0.92 };
    const shim = await shimBuildReasonCallsForSubset(candidates, relevanceMap, 0.3);
    const harness = harnessBuildReasonCallsForSubset(
      candidates,
      relevanceMap,
      0.3,
      FACT_STATEMENTS,
    );

    expect(shim.calls.map((c) => c.id)).toEqual(harness.calls.map((c) => c.id));
    expect(shim.calls.map((c) => c.system)).toEqual(harness.calls.map((c) => c.system));
    expect(shim.calls.map((c) => c.prompt)).toEqual(harness.calls.map((c) => c.prompt));
  });
});

describe('harness buildScoreCallForChunk', () => {
  it('defaults the system prompt to CLOUD_RELEVANCE_SYSTEM_PROMPT', () => {
    const { system } = buildScoreCallForChunk([candidate('a')], FACT_STATEMENTS);
    expect(system).toBe(CLOUD_RELEVANCE_SYSTEM_PROMPT);
  });
});

describe('golden — measured prompt sizes', () => {
  // These four numbers are the INPUTS to the batch-size arithmetic in
  // core/config.ts (headlineArticlesPerScorePrompt = 5 × 4386/7036 → 3). They
  // are pinned here so editing a prompt fails loudly instead of silently
  // invalidating that derivation — re-measure, redo the arithmetic, then update
  // both the comment and these pins together.
  //
  // The first two ALSO guard the CLOUD_REASON_VOICE_RULE extraction (P4a): the
  // voice paragraph was lifted out of CLOUD_REASON_SYSTEM_PROMPT into a shared
  // const so the headline reason prompt cannot carry a retyped copy. Nothing
  // else pins that prompt's content — config.test.ts and the shim comparisons
  // above are all identity checks against the same const, so a whitespace slip
  // during the extraction would have passed every existing test.
  it('pins the estimated token size of each cloud scoring prompt', () => {
    expect(estimateTokens(CLOUD_RELEVANCE_SYSTEM_PROMPT)).toBe(4386);
    expect(estimateTokens(CLOUD_REASON_SYSTEM_PROMPT)).toBe(4770);
    expect(estimateTokens(CLOUD_HEADLINE_RELEVANCE_SYSTEM_PROMPT)).toBe(7036);
    expect(estimateTokens(CLOUD_HEADLINE_REASON_SYSTEM_PROMPT)).toBe(7625);
  });

  it('keeps the headline variants strictly additive over the live prompts', () => {
    // Same base + the same shared voice rule ⇒ the headline prompt is always
    // longer than its live counterpart. If this ever inverts, something was
    // REPLACED rather than added and the tier/voice guarantees are gone.
    expect(estimateTokens(CLOUD_HEADLINE_RELEVANCE_SYSTEM_PROMPT)).toBeGreaterThan(
      estimateTokens(CLOUD_RELEVANCE_SYSTEM_PROMPT),
    );
    expect(estimateTokens(CLOUD_HEADLINE_REASON_SYSTEM_PROMPT)).toBeGreaterThan(
      estimateTokens(CLOUD_REASON_SYSTEM_PROMPT),
    );
  });
});

// ---------------------------------------------------------------------------
// P4b — the SHIM is the live path (lib/services/scoring-pipeline imports its
// builders from lib/mera-protocol/scoring-service, not from the harness). The
// blocks above only ever build standard candidates, so they would stay green
// with the headline routing wired in the harness and missing from the shim —
// exactly how this feature would ship inert. These pin shim/harness identity on
// the HEADLINE path too.
// ---------------------------------------------------------------------------

function headlineCandidate(id: string): ScoringCandidate {
  return {
    ...candidate(id),
    meta: {
      id,
      titleEn: `Title ${id}`,
      descriptionEn: `Description for ${id}`,
      publicationName: null,
      countryCode: null,
      firstPubDateMs: null,
      maxClusterSize: null,
      eventType: null,
      category: null,
      geoTagsJson: null,
      entitiesJson: null,
      matchedTopicsJson: null,
      headlineScope: 'GLOBAL',
      stableClusterId: null,
    },
  };
}

describe('golden — headline variant (P4b routing)', () => {
  it('shim and harness produce byte-identical HEADLINE score calls (incl. chunking at 3)', async () => {
    const candidates = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map(headlineCandidate);
    const shim = await shimBuildRelevanceCalls(candidates);
    const harness = harnessBuildRelevanceCalls(candidates, FACT_STATEMENTS);

    // 7 headline candidates at 3 per call = 3 calls (not 2, as 5-chunking gives).
    expect(shim.calls).toHaveLength(3);
    expect(shim.scoreChunkSize).toBe(3);
    expect(harness.scoreChunkSize).toBe(3);
    expect(shim.calls.map((c) => c.id)).toEqual(harness.calls.map((c) => c.id));
    expect(shim.calls.map((c) => c.system)).toEqual(harness.calls.map((c) => c.system));
    expect(shim.calls.map((c) => c.prompt)).toEqual(harness.calls.map((c) => c.prompt));
    expect(shim.calls.every((c) => c.system === CLOUD_HEADLINE_RELEVANCE_SYSTEM_PROMPT)).toBe(
      true,
    );
  });

  it('the SHIM routes headline candidates to the headline relevance prompt', async () => {
    const shim = await shimBuildRelevanceCalls([headlineCandidate('a')]);
    expect(shim.calls[0].system).toBe(CLOUD_HEADLINE_RELEVANCE_SYSTEM_PROMPT);
  });

  it('the SHIM keeps standard candidates on the standard prompt at chunk 5', async () => {
    const shim = await shimBuildRelevanceCalls(['a', 'b', 'c', 'd', 'e', 'f'].map(candidate));
    expect(shim.scoreChunkSize).toBe(5);
    expect(shim.calls).toHaveLength(2);
    expect(shim.calls[0].system).toBe(CLOUD_RELEVANCE_SYSTEM_PROMPT);
  });

  it('shim and harness select the headline REASON prompt per candidate, identically', async () => {
    const candidates = [headlineCandidate('h'), candidate('s')];
    const relevanceMap = { h: 0.72, s: 0.65 };
    const shim = await shimBuildReasonCallsForSubset(candidates, relevanceMap, 0.3);
    const harness = harnessBuildReasonCallsForSubset(
      candidates,
      relevanceMap,
      0.3,
      FACT_STATEMENTS,
    );

    expect(shim.calls.map((c) => c.id)).toEqual(harness.calls.map((c) => c.id));
    expect(shim.calls.map((c) => c.system)).toEqual(harness.calls.map((c) => c.system));
    const systemById = new Map(shim.calls.map((c) => [c.id, c.system] as const));
    expect(systemById.get('reason:h')).toBe(CLOUD_HEADLINE_REASON_SYSTEM_PROMPT);
    expect(systemById.get('reason:s')).toBe(CLOUD_REASON_SYSTEM_PROMPT);
  });
});
