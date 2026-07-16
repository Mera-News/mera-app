// Exercise only the pure decoder (decodeCloudBatchResults). Mock the LLM,
// database, store, and prompt imports so the module loads without native deps.
jest.mock('../../llm/completeLocal', () => ({ completeLocal: jest.fn() }));
jest.mock('../../llm/cloudComplete', () => ({
  cloudComplete: jest.fn(),
  cloudBatchComplete: jest.fn(),
}));
jest.mock('../../llm/constants', () => ({ SMALL_MODEL: 'test-small-model' }));
jest.mock('../../logger', () => ({
  __esModule: true,
  default: { warn: jest.fn(), error: jest.fn(), debug: jest.fn(), info: jest.fn() },
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
  CLOUD_RELEVANCE_SYSTEM_PROMPT: 'sys',
  CLOUD_REASON_SYSTEM_PROMPT: 'sys',
  LOCAL_RELEVANCE_SYSTEM_PROMPT: 'sys',
  LOCAL_REASON_SYSTEM_PROMPT: 'sys',
  buildBatchScoringUserMessage: jest.fn(() => 'prompt'),
  buildReasonUserMessage: jest.fn(() => 'prompt'),
}));

import {
  decodeCloudBatchResults,
  decodeResults,
  runFeedVerifierPass,
} from '../scoring-service';
import { cloudBatchComplete } from '../../llm/cloudComplete';
import type { ScoringCandidate } from '../../database/services/article-suggestion-service';

const mockCloudBatch = cloudBatchComplete as jest.MockedFunction<
  typeof cloudBatchComplete
>;

const FALLBACK_RELEVANCE = 0.3;

function candidate(id: string): ScoringCandidate {
  return {
    id,
    titleEn: `title-${id}`,
    descriptionEn: `desc-${id}`,
    countryCode: 'USA',
    userTopicIds: [],
    relatedFacts: [{ id: `f-${id}`, statement: 'a fact' }],
  };
}

describe('decodeCloudBatchResults', () => {
  it('decodes a happy-path score chunk into per-candidate scores', () => {
    const c1 = candidate('a');
    const c2 = candidate('b');
    const chunkIdToCandidates = new Map([['score:0', [c1, c2]]]);
    const promptsById = new Map([['score:0', 'p']]);

    const { scoreMap, failedIds } = decodeCloudBatchResults({
      batchResults: [{ id: 'score:0', output: '[0.8, 0.5]' }],
      promptsById,
      chunkIdToCandidates,
    });

    expect(scoreMap.get('a')).toBe(0.8);
    expect(scoreMap.get('b')).toBe(0.5);
    expect(failedIds.size).toBe(0);
  });

  it('maps a chunk error to FALLBACK_RELEVANCE for every candidate and records failedIds', () => {
    const c1 = candidate('a');
    const c2 = candidate('b');
    const chunkIdToCandidates = new Map([['score:0', [c1, c2]]]);

    const { scoreMap, failedIds } = decodeCloudBatchResults({
      batchResults: [{ id: 'score:0', output: '', error: 'upstream 500' }],
      promptsById: new Map(),
      chunkIdToCandidates,
    });

    expect(scoreMap.get('a')).toBe(FALLBACK_RELEVANCE);
    expect(scoreMap.get('b')).toBe(FALLBACK_RELEVANCE);
    expect(failedIds.has('a')).toBe(true);
    expect(failedIds.has('b')).toBe(true);
  });

  it('clamps out-of-range scores into [0, 1.1]', () => {
    const c1 = candidate('a');
    const c2 = candidate('b');
    const chunkIdToCandidates = new Map([['score:0', [c1, c2]]]);

    const { scoreMap } = decodeCloudBatchResults({
      batchResults: [{ id: 'score:0', output: '[5.0, -2.0]' }],
      promptsById: new Map(),
      chunkIdToCandidates,
    });

    expect(scoreMap.get('a')).toBe(1.1);
    expect(scoreMap.get('b')).toBe(0);
  });

  it('pads with fallback when the model returns fewer scores than candidates', () => {
    const c1 = candidate('a');
    const c2 = candidate('b');
    const chunkIdToCandidates = new Map([['score:0', [c1, c2]]]);

    const { scoreMap } = decodeCloudBatchResults({
      batchResults: [{ id: 'score:0', output: '[0.9]' }],
      promptsById: new Map(),
      chunkIdToCandidates,
    });

    expect(scoreMap.get('a')).toBe(0.9);
    expect(scoreMap.get('b')).toBe(FALLBACK_RELEVANCE);
  });

  it('falls back to all-fallback when the score output is unparseable', () => {
    const c1 = candidate('a');
    const chunkIdToCandidates = new Map([['score:0', [c1]]]);

    const { scoreMap } = decodeCloudBatchResults({
      batchResults: [{ id: 'score:0', output: 'not json at all' }],
      promptsById: new Map(),
      chunkIdToCandidates,
    });

    expect(scoreMap.get('a')).toBe(FALLBACK_RELEVANCE);
  });

  it('decodes a reason result keyed by the candidate id', () => {
    const { reasonMap } = decodeCloudBatchResults({
      batchResults: [{ id: 'reason:xyz', output: 'This matters because of X.' }],
      promptsById: new Map(),
      chunkIdToCandidates: new Map(),
    });

    expect(reasonMap.get('xyz')).toBe('This matters because of X.');
  });

  it('maps a reason error to an empty string for that id', () => {
    const { reasonMap } = decodeCloudBatchResults({
      batchResults: [{ id: 'reason:xyz', output: '', error: 'timeout' }],
      promptsById: new Map(),
      chunkIdToCandidates: new Map(),
    });

    expect(reasonMap.get('xyz')).toBe('');
  });

  it('strips boilerplate / markdown from a reason payload', () => {
    const { reasonMap } = decodeCloudBatchResults({
      batchResults: [
        {
          id: 'reason:xyz',
          output: '**Why this matters to you:** It **affects** your area.',
        },
      ],
      promptsById: new Map(),
      chunkIdToCandidates: new Map(),
    });

    expect(reasonMap.get('xyz')).toBe('It affects your area.');
  });

  it('exposes decodeResults as an alias of decodeCloudBatchResults', () => {
    expect(decodeResults).toBe(decodeCloudBatchResults);
  });
});

describe('runFeedVerifierPass (app shim — second-pass FEED verifier)', () => {
  // Reset ONLY the LLM mock — clearAllMocks would also strip the module-level
  // getFacts implementation, breaking loadAllFactStatements.
  beforeEach(() => mockCloudBatch.mockReset());

  it('audits only FEED candidates and demotes "no" articles to 0.28', async () => {
    const cands = [candidate('a'), candidate('b'), candidate('c')];
    // a, b are FEED (>= discardFloor 0.4); c is not, so it is never audited.
    const scoreMap = new Map([
      ['a', 0.9],
      ['b', 0.6],
      ['c', 0.2],
    ]);
    mockCloudBatch.mockResolvedValue([
      { id: 'verify:0', output: JSON.stringify([{ v: 'yes' }, { v: 'no' }]) },
    ]);

    const demoted = await runFeedVerifierPass(cands, scoreMap);

    expect(demoted).toBe(1);
    expect(scoreMap.get('a')).toBe(0.9); // kept
    expect(scoreMap.get('b')).toBe(0.28); // demoted
    expect(scoreMap.get('c')).toBe(0.2); // untouched (not FEED)
    // Only the two FEED candidates were sent, in one verify: chunk.
    const sentCalls = mockCloudBatch.mock.calls[0][0];
    expect(sentCalls.map((c) => c.id)).toEqual(['verify:0']);
  });

  it('fail-open: a verifier LLM error leaves every score unchanged', async () => {
    const scoreMap = new Map([['a', 0.9]]);
    mockCloudBatch.mockRejectedValue(new Error('boom'));
    const demoted = await runFeedVerifierPass([candidate('a')], scoreMap);
    expect(demoted).toBe(0);
    expect(scoreMap.get('a')).toBe(0.9);
  });

  it('no FEED candidates → no LLM call', async () => {
    const scoreMap = new Map([['a', 0.2]]);
    const demoted = await runFeedVerifierPass([candidate('a')], scoreMap);
    expect(demoted).toBe(0);
    expect(mockCloudBatch).not.toHaveBeenCalled();
  });
});
