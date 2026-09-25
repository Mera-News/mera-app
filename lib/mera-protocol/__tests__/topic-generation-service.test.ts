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
  asUntrusted: jest.fn((s: string) => s), // pass-through for unit tests
}));

import {
  parseTopicsFromOutput,
  mergeRealOutputsForFact,
  generateTopicsForFact,
  generateTopicsFromFact,
  generateRealTopicsForFact,
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
  it('delegates to generateTopicsForFact (the local engine)', async () => {
    mockCompleteLocal.mockResolvedValueOnce('["AI news"]');

    const result = await generateRealTopicsForFact({
      factStatement: 'Works in AI',
      userLocation: null,
      otherFacts: [],
      useCloud: false,
    });

    expect(result).toEqual(['AI news']);
  });
});


describe('ux2 F5: the cloud branch is retired', () => {
  it('a useCloud input never reaches the cloud; the local engine runs', async () => {
    mockCompleteLocal.mockResolvedValueOnce('["nurse staffing"]');
    const result = await generateTopicsForFact({
      factStatement: 'Works as a nurse',
      userLocation: null,
      otherFacts: [],
      useCloud: true,
    });
    expect(mockCloudBatchComplete).not.toHaveBeenCalled();
    expect(mockCompleteLocal).toHaveBeenCalled();
    expect(result).toEqual(['nurse staffing']);
  });
});
