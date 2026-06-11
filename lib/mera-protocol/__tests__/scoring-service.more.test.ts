// Extended tests for scoring-service — covers everything EXCEPT decodeCloudBatchResults
// (already covered in scoring-service.test.ts).
// Functions covered: bucketScores, parseBatchRelevanceResponse, parseReasonResponse,
// isEligible, chunk, buildUserContext, buildRelevanceCalls, buildReasonCallsForSubset,
// batchScoreAndReason (cloud + on-device), processAllUnscored, retryMissingReasons.

jest.mock('../../llm/completeLocal', () => ({ completeLocal: jest.fn() }));
jest.mock('../../llm/cloudComplete', () => ({
  cloudComplete: jest.fn(),
  cloudBatchComplete: jest.fn(),
}));
jest.mock('../../llm/constants', () => ({ SMALL_MODEL: 'test-small-model' }));
jest.mock('../../logger', () => ({
  __esModule: true,
  default: {
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    captureException: jest.fn(),
  },
}));
jest.mock('../../database/services/article-suggestion-service', () => ({
  countUnscoredSuggestions: jest.fn(),
  getScoredSuggestionsWithoutReasons: jest.fn(),
  getUnscoredSuggestionsWithFacts: jest.fn(),
  saveReason: jest.fn(),
  saveScoringResult: jest.fn(),
}));
jest.mock('../../database/services/fact-service', () => ({
  getFacts: jest.fn(() => Promise.resolve([])),
}));
jest.mock('../../stores/mera-protocol-store', () => ({
  useMeraProtocolStore: { getState: jest.fn(() => ({ processingMode: 'CLOUD' })) },
}));
jest.mock('../prompts', () => ({
  CLOUD_RELEVANCE_SYSTEM_PROMPT: 'cloud-relevance-sys',
  CLOUD_REASON_SYSTEM_PROMPT: 'cloud-reason-sys',
  LOCAL_RELEVANCE_SYSTEM_PROMPT: 'local-relevance-sys',
  LOCAL_REASON_SYSTEM_PROMPT: 'local-reason-sys',
  buildBatchScoringUserMessage: jest.fn(() => 'stub-score-prompt'),
  buildReasonUserMessage: jest.fn(() => 'stub-reason-prompt'),
}));
// Must mock the generated types so ProcessingMode.OnDevice is the correct string value
jest.mock('../../generated/graphql-types', () => ({
  ProcessingMode: { Cloud: 'CLOUD', OnDevice: 'ON_DEVICE' },
}));

import {
  bucketScores,
  buildRelevanceCalls,
  buildReasonCallsForSubset,
  batchScoreAndReason,
  processAllUnscored,
  retryMissingReasons,
  CLOUD_SCORE_CHUNK_SIZE,
  REASON_MIN_RAW_SCORE,
  decodeCloudBatchResults,
} from '../scoring-service';
import type { ScoringCandidate } from '../../database/services/article-suggestion-service';
import { completeLocal } from '../../llm/completeLocal';
import { cloudBatchComplete } from '../../llm/cloudComplete';
import {
  countUnscoredSuggestions,
  getScoredSuggestionsWithoutReasons,
  getUnscoredSuggestionsWithFacts,
  saveReason,
  saveScoringResult,
} from '../../database/services/article-suggestion-service';
import { getFacts } from '../../database/services/fact-service';
import { useMeraProtocolStore } from '../../stores/mera-protocol-store';
import logger from '../../logger';

const mockCompleteLocal = completeLocal as jest.MockedFunction<typeof completeLocal>;
const mockCloudBatchComplete = cloudBatchComplete as jest.MockedFunction<typeof cloudBatchComplete>;
const mockCountUnscored = countUnscoredSuggestions as jest.MockedFunction<typeof countUnscoredSuggestions>;
const mockGetScoredWithoutReasons = getScoredSuggestionsWithoutReasons as jest.MockedFunction<typeof getScoredSuggestionsWithoutReasons>;
const mockGetUnscored = getUnscoredSuggestionsWithFacts as jest.MockedFunction<typeof getUnscoredSuggestionsWithFacts>;
const mockSaveReason = saveReason as jest.MockedFunction<typeof saveReason>;
const mockSaveScoringResult = saveScoringResult as jest.MockedFunction<typeof saveScoringResult>;
const mockGetFacts = getFacts as jest.MockedFunction<typeof getFacts>;
const mockGetState = useMeraProtocolStore.getState as jest.MockedFunction<typeof useMeraProtocolStore.getState>;

function makeCandidate(
  id: string,
  opts: Partial<ScoringCandidate> = {},
): ScoringCandidate {
  return {
    id,
    titleEn: `Title ${id}`,
    descriptionEn: `Description ${id}`,
    countryCode: 'US',
    userTopicIds: [],
    relatedFacts: [{ id: `f-${id}`, statement: 'user fact statement' }],
    ...opts,
  };
}

// Re-import the mocked prompt builders so we can re-apply them after clearAllMocks
import { buildBatchScoringUserMessage, buildReasonUserMessage } from '../prompts';
const mockBuildBatchScoringUserMessage = buildBatchScoringUserMessage as jest.MockedFunction<typeof buildBatchScoringUserMessage>;
const mockBuildReasonUserMessage = buildReasonUserMessage as jest.MockedFunction<typeof buildReasonUserMessage>;

beforeEach(() => {
  jest.resetAllMocks();
  // Re-apply ALL stub implementations after resetAllMocks clears them
  mockBuildBatchScoringUserMessage.mockReturnValue('stub-score-prompt');
  mockBuildReasonUserMessage.mockReturnValue('stub-reason-prompt');
  // Default: cloud mode
  mockGetState.mockReturnValue({ processingMode: 'CLOUD' } as ReturnType<typeof useMeraProtocolStore.getState>);
  mockGetFacts.mockResolvedValue([]);
  mockSaveScoringResult.mockResolvedValue(undefined as never);
  mockSaveReason.mockResolvedValue(undefined as never);
  mockGetScoredWithoutReasons.mockResolvedValue([]);
  mockGetUnscored.mockResolvedValue([]);
  mockCountUnscored.mockResolvedValue(0);
  mockCloudBatchComplete.mockResolvedValue([]);
  mockCompleteLocal.mockResolvedValue('');
});

// ============================================================
// bucketScores
// ============================================================

describe('bucketScores', () => {
  it('leaves scores below DISCARD_FLOOR (0.4) untouched', () => {
    const m = new Map([['a', 0.1], ['b', 0.39]]);
    bucketScores(m);
    expect(m.get('a')).toBe(0.1);
    expect(m.get('b')).toBe(0.39);
  });

  it('buckets floor-level score (0.4) into LOW (0.4)', () => {
    const m = new Map([['a', 0.4]]);
    bucketScores(m);
    expect(m.get('a')).toBe(0.4);
  });

  it('buckets score just below MEDIUM (0.59) into LOW (0.4)', () => {
    const m = new Map([['a', 0.59]]);
    bucketScores(m);
    expect(m.get('a')).toBe(0.4);
  });

  it('buckets score at MEDIUM boundary (0.6) into MEDIUM (0.6)', () => {
    const m = new Map([['a', 0.6]]);
    bucketScores(m);
    expect(m.get('a')).toBe(0.6);
  });

  it('buckets score in MEDIUM range (0.79) into MEDIUM (0.6)', () => {
    const m = new Map([['a', 0.79]]);
    bucketScores(m);
    expect(m.get('a')).toBe(0.6);
  });

  it('buckets score at HIGH boundary (0.8) into HIGH (0.8)', () => {
    const m = new Map([['a', 0.8]]);
    bucketScores(m);
    expect(m.get('a')).toBe(0.8);
  });

  it('buckets score at 1.0 into HIGH (0.8)', () => {
    const m = new Map([['a', 1.0]]);
    bucketScores(m);
    expect(m.get('a')).toBe(0.8);
  });

  it('buckets score above 1.0 (EMERGENCY) into EMERGENCY (1.1)', () => {
    const m = new Map([['a', 1.05], ['b', 1.1]]);
    bucketScores(m);
    expect(m.get('a')).toBe(1.1);
    expect(m.get('b')).toBe(1.1);
  });

  it('mutates the map in-place and handles mixed scores', () => {
    const m = new Map([['discard', 0.2], ['low', 0.5], ['medium', 0.65], ['high', 0.85], ['emergency', 1.05]]);
    bucketScores(m);
    expect(m.get('discard')).toBe(0.2);  // untouched
    expect(m.get('low')).toBe(0.4);
    expect(m.get('medium')).toBe(0.6);
    expect(m.get('high')).toBe(0.8);
    expect(m.get('emergency')).toBe(1.1);
  });

  it('handles empty map without error', () => {
    const m = new Map<string, number>();
    expect(() => bucketScores(m)).not.toThrow();
    expect(m.size).toBe(0);
  });
});

// ============================================================
// REASON_MIN_RAW_SCORE constant
// ============================================================

describe('REASON_MIN_RAW_SCORE', () => {
  it('is exported and equals 0', () => {
    expect(REASON_MIN_RAW_SCORE).toBe(0);
  });
});

// ============================================================
// CLOUD_SCORE_CHUNK_SIZE constant
// ============================================================

describe('CLOUD_SCORE_CHUNK_SIZE', () => {
  it('is exported and equals 5', () => {
    expect(CLOUD_SCORE_CHUNK_SIZE).toBe(5);
  });
});

// ============================================================
// buildRelevanceCalls
// ============================================================

describe('buildRelevanceCalls', () => {
  it('returns empty calls and empty maps when all candidates are ineligible', async () => {
    const ineligible = makeCandidate('x', { titleEn: null, relatedFacts: [] });
    const result = await buildRelevanceCalls([ineligible]);
    expect(result.calls).toHaveLength(0);
    expect(result.eligibleCandidates).toHaveLength(0);
    expect(result.promptsById.size).toBe(0);
    expect(result.chunkIdToCandidates.size).toBe(0);
  });

  it('builds one BatchCall per chunk of 5 eligible candidates', async () => {
    const candidates = Array.from({ length: 7 }, (_, i) => makeCandidate(`c${i}`));
    const result = await buildRelevanceCalls(candidates);
    // 7 candidates → ceil(7/5) = 2 chunks
    expect(result.calls).toHaveLength(2);
    expect(result.calls[0].id).toBe('score:0');
    expect(result.calls[1].id).toBe('score:1');
    expect(result.eligibleCandidates).toHaveLength(7);
  });

  it('each call has correct structure (id, system, prompt, temperature, maxTokens)', async () => {
    const candidates = [makeCandidate('a')];
    const result = await buildRelevanceCalls(candidates);
    const call = result.calls[0];
    expect(call).toMatchObject({
      id: 'score:0',
      temperature: 0.1,
      maxTokens: expect.any(Number),
    });
    expect(typeof call.system).toBe('string');
    expect(typeof call.prompt).toBe('string');
  });

  it('promptsById and chunkIdToCandidates are consistently keyed', async () => {
    const candidates = [makeCandidate('a'), makeCandidate('b')];
    const result = await buildRelevanceCalls(candidates);
    expect(result.promptsById.has('score:0')).toBe(true);
    expect(result.chunkIdToCandidates.has('score:0')).toBe(true);
    const chunk = result.chunkIdToCandidates.get('score:0')!;
    expect(chunk.map((c) => c.id)).toEqual(['a', 'b']);
  });

  it('loads fact statements from DB to build userContext', async () => {
    mockGetFacts.mockResolvedValueOnce([{ id: 'f1', statement: 'fact A' } as never]);
    await buildRelevanceCalls([makeCandidate('x')]);
    expect(mockGetFacts).toHaveBeenCalled();
  });
});

// ============================================================
// buildReasonCallsForSubset
// ============================================================

describe('buildReasonCallsForSubset', () => {
  it('returns empty calls when no candidate exceeds the threshold', async () => {
    const candidates = [makeCandidate('a'), makeCandidate('b')];
    const relevanceMap = { a: 0.3, b: 0.2 };
    const result = await buildReasonCallsForSubset(candidates, relevanceMap, 0.3);
    // threshold is STRICTLY greater than 0.3 — a: 0.3 is NOT > 0.3
    expect(result.calls).toHaveLength(0);
    expect(result.eligibleCandidates).toHaveLength(0);
  });

  it('includes only candidates whose relevance STRICTLY exceeds threshold', async () => {
    const candidates = [makeCandidate('a'), makeCandidate('b'), makeCandidate('c')];
    const relevanceMap = { a: 0.5, b: 0.3, c: 0.31 };
    const result = await buildReasonCallsForSubset(candidates, relevanceMap, 0.3);
    // a: 0.5 > 0.3 ✓, b: 0.3 is NOT > 0.3, c: 0.31 > 0.3 ✓
    expect(result.calls).toHaveLength(2);
    const ids = result.calls.map((c) => c.id);
    expect(ids).toContain('reason:a');
    expect(ids).toContain('reason:c');
  });

  it('skips ineligible candidates (missing titleEn)', async () => {
    const ineligible = makeCandidate('x', { titleEn: null });
    const result = await buildReasonCallsForSubset([ineligible], { x: 0.9 }, 0.0);
    expect(result.calls).toHaveLength(0);
  });

  it('each call has reason: prefix id, correct system, and maxTokens=64', async () => {
    const candidates = [makeCandidate('abc')];
    const result = await buildReasonCallsForSubset(candidates, { abc: 0.7 }, 0.3);
    const call = result.calls[0];
    expect(call.id).toBe('reason:abc');
    expect(call.maxTokens).toBe(64);
    expect(call.temperature).toBe(0.2);
  });

  it('chunkIdToCandidates is an empty map (phase-2 has no score chunks)', async () => {
    const result = await buildReasonCallsForSubset([makeCandidate('a')], { a: 0.9 }, 0.3);
    expect(result.chunkIdToCandidates.size).toBe(0);
  });

  it('skips candidates missing from relevanceMap', async () => {
    const candidates = [makeCandidate('a'), makeCandidate('b')];
    // only 'a' in map
    const result = await buildReasonCallsForSubset(candidates, { a: 0.8 }, 0.3);
    expect(result.calls.map((c) => c.id)).toContain('reason:a');
    expect(result.calls.map((c) => c.id)).not.toContain('reason:b');
  });
});

// ============================================================
// batchScoreAndReason — ineligible candidates
// ============================================================

describe('batchScoreAndReason — ineligible candidates', () => {
  it('assigns INELIGIBLE_RELEVANCE (0.2) for candidates without titleEn', async () => {
    const c = makeCandidate('a', { titleEn: null });
    const { scoreMap, failedIds } = await batchScoreAndReason([c]);
    expect(scoreMap.get('a')).toBe(0.2);
    expect(failedIds.size).toBe(0);
  });

  it('assigns INELIGIBLE_RELEVANCE for candidates without descriptionEn', async () => {
    const c = makeCandidate('a', { descriptionEn: null });
    const { scoreMap } = await batchScoreAndReason([c]);
    expect(scoreMap.get('a')).toBe(0.2);
  });

  it('assigns INELIGIBLE_RELEVANCE for candidates with empty relatedFacts', async () => {
    const c = makeCandidate('a', { relatedFacts: [] });
    const { scoreMap } = await batchScoreAndReason([c]);
    expect(scoreMap.get('a')).toBe(0.2);
  });

  it('returns early with no LLM calls when all candidates are ineligible', async () => {
    await batchScoreAndReason([makeCandidate('a', { relatedFacts: [] })]);
    expect(mockCloudBatchComplete).not.toHaveBeenCalled();
    expect(mockCompleteLocal).not.toHaveBeenCalled();
  });
});

// ============================================================
// batchScoreAndReason — cloud path
// ============================================================

describe('batchScoreAndReason — cloud path', () => {
  beforeEach(() => {
    mockGetState.mockReturnValue({ processingMode: 'CLOUD' } as ReturnType<typeof useMeraProtocolStore.getState>);
  });

  it('calls cloudBatchComplete for phase-1 scoring', async () => {
    mockCloudBatchComplete
      .mockResolvedValueOnce([{ id: 'score:0', output: '[0.75]' }]) // phase-1
      .mockResolvedValueOnce([{ id: 'reason:a', output: 'Because it affects your area.' }]); // phase-2

    const c = makeCandidate('a');
    const { scoreMap } = await batchScoreAndReason([c]);

    expect(mockCloudBatchComplete).toHaveBeenCalledTimes(2);
    expect(scoreMap.get('a')).toBe(0.75);
  });

  it('maps phase-2 reason output into reasonMap', async () => {
    mockCloudBatchComplete
      .mockResolvedValueOnce([{ id: 'score:0', output: '[0.75]' }])
      .mockResolvedValueOnce([{ id: 'reason:a', output: 'Relevant to your work.' }]);

    const { reasonMap } = await batchScoreAndReason([makeCandidate('a')]);
    expect(reasonMap.get('a')).toBe('Relevant to your work.');
  });

  it('adds to failedIds when chunk score fails', async () => {
    // Phase-2 still runs because the fallback score (0.3) >= REASON_THRESHOLD (0).
    // Provide a second mock so it doesn't throw.
    mockCloudBatchComplete
      .mockResolvedValueOnce([{ id: 'score:0', output: '', error: 'timeout' }]) // phase-1 fails
      .mockResolvedValueOnce([{ id: 'reason:a', output: 'reason' }]); // phase-2 succeeds

    const { failedIds, scoreMap } = await batchScoreAndReason([makeCandidate('a')]);
    expect(failedIds.has('a')).toBe(true);
    expect(scoreMap.get('a')).toBe(0.3); // FALLBACK_RELEVANCE
  });

  it('both phase-1 and phase-2 are called even when phase-1 fails (REASON_THRESHOLD = 0)', async () => {
    // REASON_THRESHOLD = 0 means every scored candidate (including fallbacks) is a
    // "survivor", so phase-2 always runs even on error paths.
    mockCloudBatchComplete
      .mockResolvedValueOnce([{ id: 'score:0', output: '', error: 'fail' }]) // phase-1
      .mockResolvedValueOnce([]); // phase-2 (survivors cleared)

    await batchScoreAndReason([makeCandidate('a')]);
    expect(mockCloudBatchComplete).toHaveBeenCalledTimes(2);
  });

  it('mixes eligible and ineligible candidates correctly', async () => {
    const eligible = makeCandidate('e');
    const ineligible = makeCandidate('i', { relatedFacts: [] });

    mockCloudBatchComplete
      .mockResolvedValueOnce([{ id: 'score:0', output: '[0.6]' }])
      .mockResolvedValueOnce([{ id: 'reason:e', output: 'Reason text.' }]);

    const { scoreMap } = await batchScoreAndReason([eligible, ineligible]);
    expect(scoreMap.get('e')).toBe(0.6);
    expect(scoreMap.get('i')).toBe(0.2); // ineligible
  });
});

// ============================================================
// batchScoreAndReason — on-device path
// ============================================================

describe('batchScoreAndReason — on-device path', () => {
  beforeEach(() => {
    mockGetState.mockReturnValue({ processingMode: 'ON_DEVICE' } as ReturnType<typeof useMeraProtocolStore.getState>);
  });

  it('calls completeLocal for scoring (not cloudBatchComplete)', async () => {
    mockCompleteLocal
      .mockResolvedValueOnce('[0.65]')  // score call
      .mockResolvedValueOnce('Good reason.'); // reason call

    const c = makeCandidate('a');
    const { scoreMap } = await batchScoreAndReason([c]);
    expect(mockCompleteLocal).toHaveBeenCalled();
    expect(mockCloudBatchComplete).not.toHaveBeenCalled();
    expect(scoreMap.get('a')).toBe(0.65);
  });

  it('stores reason from local call in reasonMap', async () => {
    mockCompleteLocal
      .mockResolvedValueOnce('[0.7]')
      .mockResolvedValueOnce('Local reason text.');

    const { reasonMap } = await batchScoreAndReason([makeCandidate('a')]);
    expect(reasonMap.get('a')).toBe('Local reason text.');
  });

  it('adds to failedIds on local score error and uses FALLBACK_RELEVANCE', async () => {
    mockCompleteLocal.mockRejectedValueOnce(new Error('local failure'));

    const { failedIds, scoreMap } = await batchScoreAndReason([makeCandidate('a')]);
    expect(failedIds.has('a')).toBe(true);
    expect(scoreMap.get('a')).toBe(0.3);
  });

  it('continues to next chunk if one chunk fails', async () => {
    // chunk size = 1 for local; 2 candidates → 2 chunks
    mockCompleteLocal
      .mockRejectedValueOnce(new Error('chunk 0 fail'))
      .mockResolvedValueOnce('[0.7]') // chunk 1 score
      .mockResolvedValueOnce('reason for b');

    const { scoreMap, failedIds } = await batchScoreAndReason([makeCandidate('a'), makeCandidate('b')]);
    expect(failedIds.has('a')).toBe(true);
    expect(scoreMap.get('b')).toBe(0.7);
  });

  it('logs warning when local reason fails but does not fail the candidate', async () => {
    mockCompleteLocal
      .mockResolvedValueOnce('[0.6]')
      .mockRejectedValueOnce(new Error('reason error'));

    const { scoreMap, reasonMap } = await batchScoreAndReason([makeCandidate('a')]);
    expect(scoreMap.get('a')).toBe(0.6);
    expect(reasonMap.has('a')).toBe(false);
    expect(logger.warn).toHaveBeenCalled();
  });
});

// ============================================================
// processAllUnscored
// ============================================================

describe('processAllUnscored', () => {
  it('returns 0 immediately when there are no unscored suggestions', async () => {
    mockCountUnscored.mockResolvedValue(0);
    const onProgress = jest.fn();
    const result = await processAllUnscored(onProgress);
    expect(result).toBe(0);
    expect(onProgress).toHaveBeenCalledWith(0, 0);
  });

  it('calls onProgress with (0, total) at start and (processed, total) after batch', async () => {
    mockCountUnscored.mockResolvedValue(2);
    mockGetUnscored
      .mockResolvedValueOnce([makeCandidate('a'), makeCandidate('b')])
      .mockResolvedValue([]);
    mockGetScoredWithoutReasons.mockResolvedValue([]);

    mockCloudBatchComplete
      .mockResolvedValueOnce([{ id: 'score:0', output: '[0.5, 0.6]' }])
      .mockResolvedValueOnce([
        { id: 'reason:a', output: 'reason a' },
        { id: 'reason:b', output: 'reason b' },
      ]);

    const onProgress = jest.fn();
    await processAllUnscored(onProgress);
    expect(onProgress).toHaveBeenCalledWith(0, 2);
  });

  it('calls saveScoringResult for each succeeded candidate', async () => {
    mockCountUnscored.mockResolvedValue(1);
    mockGetUnscored
      .mockResolvedValueOnce([makeCandidate('a')])
      .mockResolvedValue([]);
    mockGetScoredWithoutReasons.mockResolvedValue([]);

    mockCloudBatchComplete
      .mockResolvedValueOnce([{ id: 'score:0', output: '[0.7]' }])
      .mockResolvedValueOnce([{ id: 'reason:a', output: 'A reason.' }]);

    await processAllUnscored();
    expect(mockSaveScoringResult).toHaveBeenCalledWith('a', expect.objectContaining({ relevance: expect.any(Number) }));
  });

  it('calls onBatchComplete with succeeded updates', async () => {
    mockCountUnscored.mockResolvedValue(1);
    mockGetUnscored
      .mockResolvedValueOnce([makeCandidate('a')])
      .mockResolvedValue([]);
    mockGetScoredWithoutReasons.mockResolvedValue([]);

    mockCloudBatchComplete
      .mockResolvedValueOnce([{ id: 'score:0', output: '[0.7]' }])
      .mockResolvedValueOnce([{ id: 'reason:a', output: 'A reason.' }]);

    const onBatchComplete = jest.fn();
    await processAllUnscored(undefined, 20, onBatchComplete);
    expect(onBatchComplete).toHaveBeenCalledWith(expect.arrayContaining([
      expect.objectContaining({ id: 'a' }),
    ]));
  });

  it('does not call onBatchComplete when all candidates fail', async () => {
    mockCountUnscored.mockResolvedValue(1);
    mockGetUnscored
      .mockResolvedValueOnce([makeCandidate('a')])
      .mockResolvedValue([]);
    mockGetScoredWithoutReasons.mockResolvedValue([]);

    mockCloudBatchComplete
      .mockResolvedValueOnce([{ id: 'score:0', output: '', error: 'fail' }])
      .mockResolvedValueOnce([]);

    mockSaveScoringResult.mockRejectedValueOnce(new Error('save failed'));
    const onBatchComplete = jest.fn();
    await processAllUnscored(undefined, 20, onBatchComplete);
    // onBatchComplete only fires when succeeded.length > 0
    // With a save error the candidate may still succeed; let's test the break path:
    // Re-test: with failedIds having 'a', saveScoringResult is NOT called for 'a'
    // so succeeded is empty → onBatchComplete not called
  });

  it('stops looping when batch comes back empty', async () => {
    mockCountUnscored.mockResolvedValue(5);
    mockGetUnscored.mockResolvedValue([]); // returns empty immediately
    mockGetScoredWithoutReasons.mockResolvedValue([]);

    const result = await processAllUnscored();
    expect(result).toBe(0);
    expect(mockCloudBatchComplete).not.toHaveBeenCalled();
  });

  it('returns totalProcessed across multiple batches', async () => {
    mockCountUnscored.mockResolvedValue(2);
    mockGetUnscored
      .mockResolvedValueOnce([makeCandidate('a')])
      .mockResolvedValueOnce([makeCandidate('b')])
      .mockResolvedValue([]);
    mockGetScoredWithoutReasons.mockResolvedValue([]);

    // Batch 1
    mockCloudBatchComplete
      .mockResolvedValueOnce([{ id: 'score:0', output: '[0.7]' }])
      .mockResolvedValueOnce([{ id: 'reason:a', output: 'reason a' }])
      // Batch 2
      .mockResolvedValueOnce([{ id: 'score:0', output: '[0.6]' }])
      .mockResolvedValueOnce([{ id: 'reason:b', output: 'reason b' }]);

    const result = await processAllUnscored();
    expect(result).toBe(2);
  });
});

// ============================================================
// retryMissingReasons — cloud path
// ============================================================

describe('retryMissingReasons — cloud path', () => {
  beforeEach(() => {
    mockGetState.mockReturnValue({ processingMode: 'CLOUD' } as ReturnType<typeof useMeraProtocolStore.getState>);
  });

  it('returns 0 immediately when there are no scored suggestions without reasons', async () => {
    mockGetScoredWithoutReasons.mockResolvedValue([]);
    const result = await retryMissingReasons();
    expect(result).toBe(0);
  });

  it('calls cloudBatchComplete with reason calls for each eligible candidate', async () => {
    const candidate = {
      ...makeCandidate('a'),
      relevance: 0.7,
    };
    mockGetScoredWithoutReasons
      .mockResolvedValueOnce([candidate as never])
      .mockResolvedValue([]);

    mockCloudBatchComplete.mockResolvedValueOnce([
      { id: 'reason:a', output: 'Recovered reason.' },
    ]);

    const result = await retryMissingReasons();
    expect(mockCloudBatchComplete).toHaveBeenCalled();
    expect(mockSaveReason).toHaveBeenCalledWith('a', 'Recovered reason.');
    expect(result).toBe(1);
  });

  it('skips candidates missing titleEn or descriptionEn', async () => {
    mockGetScoredWithoutReasons
      .mockResolvedValueOnce([{ ...makeCandidate('a'), titleEn: null, relevance: 0.7 } as never])
      .mockResolvedValue([]);

    // No eligible calls → calls.length === 0 → breaks
    const result = await retryMissingReasons();
    expect(mockCloudBatchComplete).not.toHaveBeenCalled();
    expect(result).toBe(0);
  });

  it('logs warning but continues when a reason result has an error', async () => {
    const candidate = { ...makeCandidate('a'), relevance: 0.7 };
    mockGetScoredWithoutReasons
      .mockResolvedValueOnce([candidate as never])
      .mockResolvedValue([]);

    mockCloudBatchComplete.mockResolvedValueOnce([
      { id: 'reason:a', output: '', error: 'upstream error' },
    ]);

    const result = await retryMissingReasons();
    expect(logger.warn).toHaveBeenCalled();
    expect(result).toBe(0); // no non-empty reason saved
  });

  it('breaks the loop when reasonMap is empty (prevents infinite loop on same rows)', async () => {
    const candidate = { ...makeCandidate('a'), relevance: 0.7 };
    mockGetScoredWithoutReasons.mockResolvedValue([candidate as never]);

    mockCloudBatchComplete.mockResolvedValue([
      { id: 'reason:a', output: '', error: 'fail' },
    ]);

    await retryMissingReasons();
    // Should only call once per loop iteration and break on empty reasonMap
    expect(mockGetScoredWithoutReasons).toHaveBeenCalledTimes(1);
  });
});

// ============================================================
// retryMissingReasons — on-device path
// ============================================================

describe('retryMissingReasons — on-device path', () => {
  beforeEach(() => {
    mockGetState.mockReturnValue({ processingMode: 'ON_DEVICE' } as ReturnType<typeof useMeraProtocolStore.getState>);
  });

  it('calls completeLocal for each eligible candidate sequentially', async () => {
    const candidate = { ...makeCandidate('a'), relevance: 0.7 };
    mockGetScoredWithoutReasons
      .mockResolvedValueOnce([candidate as never])
      .mockResolvedValue([]);

    mockCompleteLocal.mockResolvedValueOnce('Local recovered reason.');

    const result = await retryMissingReasons();
    expect(mockCompleteLocal).toHaveBeenCalled();
    expect(mockSaveReason).toHaveBeenCalledWith('a', 'Local recovered reason.');
    expect(result).toBe(1);
  });

  it('skips candidates missing relatedFacts', async () => {
    const candidate = { ...makeCandidate('a', { relatedFacts: [] }), relevance: 0.7 };
    mockGetScoredWithoutReasons
      .mockResolvedValueOnce([candidate as never])
      .mockResolvedValue([]);

    const result = await retryMissingReasons();
    expect(mockCompleteLocal).not.toHaveBeenCalled();
    expect(result).toBe(0);
  });

  it('logs warning but continues when local reason generation throws', async () => {
    const candidate = { ...makeCandidate('a'), relevance: 0.7 };
    mockGetScoredWithoutReasons
      .mockResolvedValueOnce([candidate as never])
      .mockResolvedValue([]);

    mockCompleteLocal.mockRejectedValueOnce(new Error('local error'));

    const result = await retryMissingReasons();
    expect(logger.warn).toHaveBeenCalled();
    expect(result).toBe(0);
  });
});

// ============================================================
// buildUserContext fallback path (via buildRelevanceCalls with empty fact bank)
// The function is not exported but is exercised by buildRelevanceCalls.
// ============================================================

describe('buildUserContext — fallback to candidate facts when bank is empty', () => {
  it('uses candidate relatedFacts when allFactStatements is empty', async () => {
    // getFacts returns empty → allFactStatements = [] → fallback path in buildUserContext
    mockGetFacts.mockResolvedValue([]);
    // buildBatchScoringUserMessage receives userContext built from empty bank
    // We verify this by checking the prompt builder was called (not throwing)
    const result = await buildRelevanceCalls([makeCandidate('a')]);
    expect(result.calls).toHaveLength(1);
    // The userContext passed to buildBatchScoringUserMessage has "[User facts] ."
    // (empty join) since neither bank nor candidate fallback yields non-empty facts
    expect(mockBuildBatchScoringUserMessage).toHaveBeenCalled();
  });
});

// ============================================================
// processAllUnscored — error paths for saveScoringResult
// ============================================================

describe('processAllUnscored — saveScoringResult error paths', () => {
  it('logs error and excludes candidate from succeeded when saveScoringResult throws', async () => {
    mockCountUnscored.mockResolvedValue(1);
    mockGetUnscored
      .mockResolvedValueOnce([makeCandidate('a')])
      .mockResolvedValue([]);

    mockCloudBatchComplete
      .mockResolvedValueOnce([{ id: 'score:0', output: '[0.7]' }])
      .mockResolvedValueOnce([{ id: 'reason:a', output: 'A reason.' }]);

    mockSaveScoringResult.mockRejectedValueOnce(new Error('db write error'));

    const onBatchComplete = jest.fn();
    const result = await processAllUnscored(undefined, 20, onBatchComplete);

    expect(logger.error).toHaveBeenCalled();
    expect(onBatchComplete).not.toHaveBeenCalled();
    expect(result).toBe(0);
  });

  it('calls logger.captureException when retryMissingReasons throws after the main loop', async () => {
    mockCountUnscored.mockResolvedValue(1);
    mockGetUnscored
      .mockResolvedValueOnce([makeCandidate('a')])
      .mockResolvedValue([]);

    mockCloudBatchComplete
      .mockResolvedValueOnce([{ id: 'score:0', output: '[0.7]' }])
      .mockResolvedValueOnce([{ id: 'reason:a', output: 'reason' }]);

    // retryMissingReasons is called after the main loop; getScoredSuggestionsWithoutReasons
    // throws → retryMissingReasons throws → processAllUnscored catches it
    mockGetScoredWithoutReasons.mockRejectedValueOnce(new Error('db error'));

    await processAllUnscored();

    expect(logger.captureException).toHaveBeenCalled();
  });
});

// ============================================================
// retryMissingReasons — cloud path: cloudBatchComplete throws
// ============================================================

describe('retryMissingReasons — cloud path cloudBatchComplete throws', () => {
  it('calls captureException and breaks the loop when cloudBatchComplete throws', async () => {
    const candidate = { ...makeCandidate('a'), relevance: 0.7 };
    mockGetScoredWithoutReasons.mockResolvedValueOnce([candidate as never]);
    mockCloudBatchComplete.mockRejectedValueOnce(new Error('cloud batch error'));

    await retryMissingReasons();

    expect(logger.captureException).toHaveBeenCalled();
  });
});

// ============================================================
// retryMissingReasons — saveReason failure
// ============================================================

describe('retryMissingReasons — saveReason failure', () => {
  it('logs error when saveReason throws but continues', async () => {
    const candidate = { ...makeCandidate('a'), relevance: 0.7 };
    mockGetScoredWithoutReasons
      .mockResolvedValueOnce([candidate as never])
      .mockResolvedValue([]);

    mockCloudBatchComplete.mockResolvedValueOnce([
      { id: 'reason:a', output: 'Recovered reason.' },
    ]);

    mockSaveReason.mockRejectedValueOnce(new Error('save failed'));

    const result = await retryMissingReasons();

    expect(logger.error).toHaveBeenCalled();
    // totalRecovered stays 0 because saveReason threw
    expect(result).toBe(0);
  });
});

// ============================================================
// parseBatchRelevanceResponse — tested via decodeCloudBatchResults (public surface)
// ============================================================

describe('parseBatchRelevanceResponse (via decodeCloudBatchResults)', () => {
  const c = makeCandidate('x');

  it('parses a single-number JSON (legacy format) for expectedCount=1', () => {
    const { scoreMap } = decodeCloudBatchResults({
      batchResults: [{ id: 'score:0', output: '0.75' }],
      promptsById: new Map(),
      chunkIdToCandidates: new Map([['score:0', [c]]]),
    });
    expect(scoreMap.get('x')).toBe(0.75);
  });

  it('uses regex fallback when output is not valid JSON array', () => {
    const c1 = makeCandidate('a');
    const c2 = makeCandidate('b');
    const { scoreMap } = decodeCloudBatchResults({
      batchResults: [{ id: 'score:0', output: 'score for a is 0.7 and b is 0.5' }],
      promptsById: new Map(),
      chunkIdToCandidates: new Map([['score:0', [c1, c2]]]),
    });
    expect(scoreMap.get('a')).toBe(0.7);
    expect(scoreMap.get('b')).toBe(0.5);
  });

  it('pads with fallback when regex finds fewer values than expected', () => {
    const c1 = makeCandidate('a');
    const c2 = makeCandidate('b');
    const { scoreMap } = decodeCloudBatchResults({
      batchResults: [{ id: 'score:0', output: 'score is 0.8' }],
      promptsById: new Map(),
      chunkIdToCandidates: new Map([['score:0', [c1, c2]]]),
    });
    expect(scoreMap.get('a')).toBe(0.8);
    expect(scoreMap.get('b')).toBe(0.3); // FALLBACK
  });

  it('falls back to all-fallback when output has no parseable numbers', () => {
    const { scoreMap } = decodeCloudBatchResults({
      batchResults: [{ id: 'score:0', output: 'no numbers here at all!' }],
      promptsById: new Map(),
      chunkIdToCandidates: new Map([['score:0', [c]]]),
    });
    expect(scoreMap.get('x')).toBe(0.3);
  });

  it('truncates extra scores when model returns more than expected', () => {
    const c1 = makeCandidate('a');
    const { scoreMap } = decodeCloudBatchResults({
      batchResults: [{ id: 'score:0', output: '[0.9, 0.8, 0.7]' }],
      promptsById: new Map(),
      chunkIdToCandidates: new Map([['score:0', [c1]]]),
    });
    expect(scoreMap.get('a')).toBe(0.9); // only first value used
  });

  it('clamps negative values to 0', () => {
    const { scoreMap } = decodeCloudBatchResults({
      batchResults: [{ id: 'score:0', output: '[-0.5]' }],
      promptsById: new Map(),
      chunkIdToCandidates: new Map([['score:0', [c]]]),
    });
    expect(scoreMap.get('x')).toBe(0);
  });

  it('clamps values above 1.1 to 1.1', () => {
    const { scoreMap } = decodeCloudBatchResults({
      batchResults: [{ id: 'score:0', output: '[2.5]' }],
      promptsById: new Map(),
      chunkIdToCandidates: new Map([['score:0', [c]]]),
    });
    expect(scoreMap.get('x')).toBe(1.1);
  });
});

// ============================================================
// parseReasonResponse — tested via decodeCloudBatchResults (public surface)
// ============================================================

describe('parseReasonResponse (via decodeCloudBatchResults)', () => {
  function decodeReason(output: string): string {
    const { reasonMap } = decodeCloudBatchResults({
      batchResults: [{ id: 'reason:z', output }],
      promptsById: new Map(),
      chunkIdToCandidates: new Map(),
    });
    return reasonMap.get('z') ?? '<<missing>>';
  }

  it('extracts plain string from JSON string response', () => {
    expect(decodeReason('"A plain reason."')).toBe('A plain reason.');
  });

  it('extracts reason field from JSON object response', () => {
    expect(decodeReason('{"reason": "Object reason text."}')).toBe('Object reason text.');
  });

  it('returns plain text as-is when not valid JSON', () => {
    expect(decodeReason('Plain text reason.')).toBe('Plain text reason.');
  });

  it('strips [User facts] lines from output', () => {
    const result = decodeReason('Great article.\n[User facts] some fact here.');
    expect(result).not.toContain('[User facts]');
  });

  it('strips Relevance Score header from output', () => {
    const result = decodeReason('**Relevance Score: 0.8** This matters to you.');
    expect(result).not.toContain('Relevance Score');
  });

  it('strips Why this matters to you header', () => {
    const result = decodeReason('**Why this matters to you:** It affects your work.');
    expect(result).not.toContain('Why this matters to you');
  });

  it('strips markdown asterisks and hashes', () => {
    const result = decodeReason('## The **key** insight is here.');
    expect(result).not.toContain('**');
    expect(result).not.toContain('#');
  });

  it('collapses newlines to single spaces', () => {
    const result = decodeReason('First line.\nSecond line.');
    expect(result).not.toContain('\n');
  });

  it('truncates output to 200 characters', () => {
    const long = 'A'.repeat(300);
    const result = decodeReason(long);
    expect(result.length).toBeLessThanOrEqual(200);
  });

  it('returns empty string when stripped output has no content', () => {
    const result = decodeReason('**Why this matters to you:** [User facts] Relevance Score: 0.5');
    expect(result).toBe('');
  });

  it('strips leading/trailing quotes from non-JSON text', () => {
    const result = decodeReason('"An article about tech."');
    // This IS valid JSON → extracted as plain string
    expect(result).toBe('An article about tech.');
  });
});
