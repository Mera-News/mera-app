// Tests for topic-generation-service.ts
// Mocks: LLM calls (completeLocal, cloudBatchComplete), logger, prompts (constants only).

jest.mock('../../llm/completeLocal', () => ({ completeLocal: jest.fn() }));
jest.mock('../../llm/cloudComplete', () => ({
  cloudBatchComplete: jest.fn(),
}));
jest.mock('../../logger', () => ({
  __esModule: true,
  default: { warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../prompts', () => ({
  CLOUD_TOPIC_GENERATION_SYSTEM_PROMPT: 'cloud-topic-sys',
  CLOUD_FACT_COMBO_TOPIC_GENERATION_SYSTEM_PROMPT: 'cloud-combo-sys',
  LOCAL_TOPIC_GENERATION_SYSTEM_PROMPT: 'local-topic-sys',
  LOCAL_FACT_COMBO_TOPIC_GENERATION_SYSTEM_PROMPT: 'local-combo-sys',
  sanitizeForPrompt: jest.fn((s: string) => s), // pass-through for unit tests
}));

import {
  parseTopicsFromOutput,
  mergeRealOutputsForFact,
  generateTopicsForFact,
  generateTopicsFromFact,
  generateRealTopicsForFact,
  buildCloudBatchCallsForFact,
} from '../topic-generation-service';
import { completeLocal } from '../../llm/completeLocal';
import { cloudBatchComplete } from '../../llm/cloudComplete';
import logger from '../../logger';

const mockCompleteLocal = completeLocal as jest.MockedFunction<typeof completeLocal>;
const mockCloudBatchComplete = cloudBatchComplete as jest.MockedFunction<typeof cloudBatchComplete>;

beforeEach(() => {
  jest.clearAllMocks();
});

// ============================================================
// parseTopicsFromOutput
// ============================================================

describe('parseTopicsFromOutput', () => {
  const fact = 'Lives in Amsterdam';

  it('parses a valid JSON array of strings', () => {
    const result = parseTopicsFromOutput('["Amsterdam news", "Dutch politics"]', fact);
    expect(result).toEqual(['Amsterdam news', 'Dutch politics']);
  });

  it('filters out non-string elements from a JSON array', () => {
    const result = parseTopicsFromOutput('["AI news", 42, null, "tech policy"]', fact);
    expect(result).toEqual(['AI news', 'tech policy']);
  });

  it('filters out empty strings', () => {
    const result = parseTopicsFromOutput('["AI news", "", "  ", "tech"]', fact);
    expect(result).toEqual(['AI news', 'tech']);
  });

  it('trims whitespace from each topic', () => {
    const result = parseTopicsFromOutput('["  AI news  ", " tech "]', fact);
    expect(result).toEqual(['AI news', 'tech']);
  });

  it('caps results at 20 topics', () => {
    const arr = Array.from({ length: 25 }, (_, i) => `topic ${i}`);
    const result = parseTopicsFromOutput(JSON.stringify(arr), fact);
    expect(result.length).toBe(20);
  });

  it('uses bracket-regex fallback when outer text wraps a JSON array', () => {
    const result = parseTopicsFromOutput(
      'Here are the topics: ["Amsterdam news", "EU regulation"] — end',
      fact,
    );
    expect(result).toEqual(['Amsterdam news', 'EU regulation']);
  });

  it('returns [] and logs warning when output is completely unparseable', () => {
    const result = parseTopicsFromOutput('no json here', fact);
    expect(result).toEqual([]);
    expect(logger.warn).toHaveBeenCalled();
  });

  it('returns [] for an empty string', () => {
    const result = parseTopicsFromOutput('', fact);
    expect(result).toEqual([]);
  });

  it('returns [] when JSON array is empty', () => {
    const result = parseTopicsFromOutput('[]', fact);
    expect(result).toEqual([]);
  });

  it('handles output with markdown code fence wrapping the array', () => {
    const result = parseTopicsFromOutput(
      '```json\n["Amsterdam news", "EU tech"]\n```',
      fact,
    );
    // The bracket-regex path extracts the inner array
    expect(result).toEqual(['Amsterdam news', 'EU tech']);
  });

  it('handles a JSON array with extra trailing text after the bracket', () => {
    const result = parseTopicsFromOutput(
      '["Amsterdam news", "EU regulation"] some note',
      fact,
    );
    // Primary JSON.parse would fail; bracket-regex should succeed
    expect(result).toEqual(['Amsterdam news', 'EU regulation']);
  });
});

// ============================================================
// mergeRealOutputsForFact
// ============================================================

describe('mergeRealOutputsForFact', () => {
  const fact = 'Works in AI';

  it('merges factOnly and combo outputs with factOnly first', () => {
    const result = mergeRealOutputsForFact(
      '["AI news", "ML research"]',
      '["DeepMind news", "AI startups"]',
      fact,
    );
    expect(result).toEqual(['AI news', 'ML research', 'DeepMind news', 'AI startups']);
  });

  it('deduplicates case-insensitively', () => {
    const result = mergeRealOutputsForFact(
      '["AI News", "ML research"]',
      '["ai news", "AI startups"]', // "ai news" is a duplicate of "AI News"
      fact,
    );
    expect(result).toHaveLength(3);
    expect(result).toContain('AI News');
    expect(result).toContain('ML research');
    expect(result).toContain('AI startups');
  });

  it('handles null factOnly output', () => {
    const result = mergeRealOutputsForFact(null, '["combo topic"]', fact);
    expect(result).toEqual(['combo topic']);
  });

  it('handles null combo output', () => {
    const result = mergeRealOutputsForFact('["factOnly topic"]', null, fact);
    expect(result).toEqual(['factOnly topic']);
  });

  it('returns [] when both are null', () => {
    const result = mergeRealOutputsForFact(null, null, fact);
    expect(result).toEqual([]);
  });

  it('deduplicates topics that differ only in trailing spaces', () => {
    const result = mergeRealOutputsForFact(
      '["AI news"]',
      '["AI news  "]',
      fact,
    );
    expect(result).toHaveLength(1);
  });

  it('preserves original casing from first occurrence', () => {
    const result = mergeRealOutputsForFact(
      '["AI News"]',
      '["ai news"]',
      fact,
    );
    expect(result[0]).toBe('AI News');
  });
});

// ============================================================
// buildCloudBatchCallsForFact
// ============================================================

describe('buildCloudBatchCallsForFact', () => {
  const baseInputs = {
    factStatement: 'Lives in Amsterdam',
    userLocation: 'Amsterdam, Netherlands',
    otherFacts: [],
    totalCount: 16,
  };

  it('returns one call (factOnly) when otherFacts is empty', () => {
    const calls = buildCloudBatchCallsForFact(baseInputs, 'fact1');
    expect(calls).toHaveLength(1);
    expect(calls[0].id).toBe('fact1:factOnly');
  });

  it('returns two calls when otherFacts is non-empty', () => {
    const calls = buildCloudBatchCallsForFact(
      { ...baseInputs, otherFacts: ['Works in AI'] },
      'fact1',
    );
    expect(calls).toHaveLength(2);
    const ids = calls.map((c) => c.id);
    expect(ids).toContain('fact1:factOnly');
    expect(ids).toContain('fact1:combo');
  });

  it('uses different system prompts for factOnly and combo calls', () => {
    const calls = buildCloudBatchCallsForFact(
      { ...baseInputs, otherFacts: ['Works in AI'] },
      'f',
    );
    const factOnly = calls.find((c) => c.id === 'f:factOnly')!;
    const combo = calls.find((c) => c.id === 'f:combo')!;
    expect(factOnly.system).toBe('cloud-topic-sys');
    expect(combo.system).toBe('cloud-combo-sys');
  });

  it('splits count roughly 50/50 when otherFacts exist', () => {
    const calls = buildCloudBatchCallsForFact(
      { ...baseInputs, totalCount: 16, otherFacts: ['a fact'] },
      'f',
    );
    const factOnly = calls.find((c) => c.id === 'f:factOnly')!;
    const combo = calls.find((c) => c.id === 'f:combo')!;
    // factOnly = floor(16/2) = 8, combo = 16 - 8 = 8
    expect(factOnly.prompt).toContain('Generate 8 topics');
    expect(combo.prompt).toContain('Generate 8 topics');
  });

  it('uses full count for factOnly when no others exist', () => {
    const calls = buildCloudBatchCallsForFact(
      { ...baseInputs, totalCount: 14 },
      'f',
    );
    expect(calls[0].prompt).toContain('Generate 14 topics');
  });

  it('sets temperature to 0.3 for all calls', () => {
    const calls = buildCloudBatchCallsForFact(baseInputs, 'f');
    calls.forEach((c) => expect(c.temperature).toBe(0.3));
  });

  it('uses default total of 16 when totalCount is not provided', () => {
    const calls = buildCloudBatchCallsForFact(
      { factStatement: 'Works in AI', userLocation: null, otherFacts: [] },
      'f',
    );
    expect(calls[0].prompt).toContain('Generate 16 topics');
  });

  it('includes userLocation in prompt when provided', () => {
    const calls = buildCloudBatchCallsForFact(baseInputs, 'f');
    expect(calls[0].prompt).toContain('Amsterdam, Netherlands');
  });

  it('omits userLocation line when null', () => {
    const calls = buildCloudBatchCallsForFact(
      { ...baseInputs, userLocation: null },
      'f',
    );
    expect(calls[0].prompt).not.toContain('User location');
  });

  it('includes other facts in combo prompt', () => {
    const calls = buildCloudBatchCallsForFact(
      { ...baseInputs, otherFacts: ['Works as engineer', 'Has kids'] },
      'f',
    );
    const combo = calls.find((c) => c.id === 'f:combo')!;
    expect(combo.prompt).toContain('Works as engineer');
    expect(combo.prompt).toContain('Has kids');
  });
});

// ============================================================
// generateTopicsFromFact (local-only wrapper)
// ============================================================

describe('generateTopicsFromFact', () => {
  it('calls completeLocal and returns parsed topics', async () => {
    mockCompleteLocal.mockResolvedValueOnce('["Amsterdam news", "Dutch politics"]');
    const result = await generateTopicsFromFact('Lives in Amsterdam');
    expect(mockCompleteLocal).toHaveBeenCalledTimes(1);
    expect(result).toEqual(['Amsterdam news', 'Dutch politics']);
  });

  it('returns [] when completeLocal returns unparseable output', async () => {
    mockCompleteLocal.mockResolvedValueOnce('not valid json');
    const result = await generateTopicsFromFact('some fact');
    expect(result).toEqual([]);
  });
});

// ============================================================
// generateTopicsForFact — cloud path
// ============================================================

describe('generateTopicsForFact — cloud path', () => {
  it('calls cloudBatchComplete and returns merged topics', async () => {
    mockCloudBatchComplete.mockResolvedValueOnce([
      { id: 'factOnly', output: '["AI news", "ML policy"]' },
      { id: 'combo', output: '["DeepMind funding"]' },
    ]);

    const result = await generateTopicsForFact({
      factStatement: 'Senior ML engineer at DeepMind',
      userLocation: 'Amsterdam',
      otherFacts: ['Interested in F1'],
      useCloud: true,
    });

    expect(mockCloudBatchComplete).toHaveBeenCalled();
    expect(result).toContain('AI news');
    expect(result).toContain('ML policy');
    expect(result).toContain('DeepMind funding');
  });

  it('skips combo call when otherFacts is empty (cloud)', async () => {
    mockCloudBatchComplete.mockResolvedValueOnce([
      { id: 'factOnly', output: '["AI news"]' },
    ]);

    await generateTopicsForFact({
      factStatement: 'Works in AI',
      userLocation: null,
      otherFacts: [],
      useCloud: true,
    });

    const calls = mockCloudBatchComplete.mock.calls[0][0];
    expect(calls).toHaveLength(1);
    expect(calls[0].id).toBe('factOnly');
  });

  it('returns [] when cloudBatchComplete returns all errors', async () => {
    mockCloudBatchComplete.mockResolvedValueOnce([
      { id: 'factOnly', output: '', error: 'fail' },
    ]);

    const result = await generateTopicsForFact({
      factStatement: 'Works in AI',
      userLocation: null,
      otherFacts: [],
      useCloud: true,
    });

    expect(result).toEqual([]);
  });

  it('logs warning when a cloud half fails and continues with remaining', async () => {
    mockCloudBatchComplete.mockResolvedValueOnce([
      { id: 'factOnly', output: '["AI news"]' },
      { id: 'combo', output: '', error: 'combo fail' },
    ]);

    const result = await generateTopicsForFact({
      factStatement: 'Works in AI',
      userLocation: null,
      otherFacts: ['other fact'],
      useCloud: true,
    });

    expect(logger.warn).toHaveBeenCalled();
    expect(result).toEqual(['AI news']);
  });

  it('returns [] when cloudBatchComplete throws', async () => {
    mockCloudBatchComplete.mockRejectedValueOnce(new Error('network error'));

    const result = await generateTopicsForFact({
      factStatement: 'Works in AI',
      userLocation: null,
      otherFacts: [],
      useCloud: true,
    });

    expect(result).toEqual([]);
  });

  it('deduplicates across factOnly and combo results', async () => {
    mockCloudBatchComplete.mockResolvedValueOnce([
      { id: 'factOnly', output: '["AI news", "ML research"]' },
      { id: 'combo', output: '["ai news", "DeepMind funding"]' }, // "ai news" is duplicate
    ]);

    const result = await generateTopicsForFact({
      factStatement: 'Works in AI',
      userLocation: null,
      otherFacts: ['other'],
      useCloud: true,
    });

    const lowerCased = result.map((r) => r.toLowerCase());
    const uniqueLower = new Set(lowerCased);
    expect(uniqueLower.size).toBe(result.length);
  });
});

// ============================================================
// generateTopicsForFact — local path
// ============================================================

describe('generateTopicsForFact — local path', () => {
  it('calls completeLocal for factOnly and combo when otherFacts exist', async () => {
    mockCompleteLocal
      .mockResolvedValueOnce('["AI news"]')
      .mockResolvedValueOnce('["AI Amsterdam combo"]');

    const result = await generateTopicsForFact({
      factStatement: 'Works in AI',
      userLocation: 'Amsterdam',
      otherFacts: ['another fact'],
      useCloud: false,
    });

    expect(mockCompleteLocal).toHaveBeenCalledTimes(2);
    expect(result).toContain('AI news');
    expect(result).toContain('AI Amsterdam combo');
  });

  it('calls completeLocal once when otherFacts is empty', async () => {
    mockCompleteLocal.mockResolvedValueOnce('["AI news"]');

    await generateTopicsForFact({
      factStatement: 'Works in AI',
      userLocation: null,
      otherFacts: [],
      useCloud: false,
    });

    expect(mockCompleteLocal).toHaveBeenCalledTimes(1);
  });

  it('continues with factOnly result if combo call fails locally', async () => {
    mockCompleteLocal
      .mockResolvedValueOnce('["AI news"]')
      .mockRejectedValueOnce(new Error('local combo fail'));

    const result = await generateTopicsForFact({
      factStatement: 'Works in AI',
      userLocation: null,
      otherFacts: ['other fact'],
      useCloud: false,
    });

    expect(result).toEqual(['AI news']);
    expect(logger.warn).toHaveBeenCalled();
  });

  it('returns [] when all local calls fail', async () => {
    mockCompleteLocal.mockRejectedValueOnce(new Error('fail'));

    const result = await generateTopicsForFact({
      factStatement: 'Works in AI',
      userLocation: null,
      otherFacts: [],
      useCloud: false,
    });

    expect(result).toEqual([]);
  });

  it('respects custom totalCount', async () => {
    mockCompleteLocal.mockResolvedValueOnce('["topic a", "topic b", "topic c"]');

    const result = await generateTopicsForFact({
      factStatement: 'Works in AI',
      userLocation: null,
      otherFacts: [],
      useCloud: false,
      totalCount: 3,
    });

    expect(mockCompleteLocal.mock.calls[0][0].prompt).toContain('Generate 3 topics');
  });
});

// ============================================================
// generateRealTopicsForFact — back-compat alias
// ============================================================

describe('generateRealTopicsForFact', () => {
  it('delegates to generateTopicsForFact (cloud)', async () => {
    mockCloudBatchComplete.mockResolvedValueOnce([
      { id: 'factOnly', output: '["AI news"]' },
    ]);

    const result = await generateRealTopicsForFact({
      factStatement: 'Works in AI',
      userLocation: null,
      otherFacts: [],
      useCloud: true,
    });

    expect(result).toEqual(['AI news']);
  });
});
