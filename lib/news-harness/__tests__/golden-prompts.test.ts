// Golden test: the old-path shim (lib/mera-protocol/scoring-service) and the
// harness must build byte-identical score/reason BatchCalls. Prompts are NOT
// mocked (real); only the shim's RN dependencies (LLM, DB, store, logger) are.

jest.mock('@/lib/llm/completeLocal', () => ({ completeLocal: jest.fn() }));
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
import { CLOUD_RELEVANCE_SYSTEM_PROMPT } from '../prompts/prompts';
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
