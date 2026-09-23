// stage-scoring — the on-device relevance lane.
//
// Pins the fix for a silent failure: local mode used to send the ~4.6k-token
// CLOUD relevance prompt, five articles per call, into a 4,096-token context.
// llama.rn answers that with empty text and no error, so every article fell to
// `fallbackRelevance` and no reason was ever written.

jest.mock('@/lib/llm/cloudComplete', () => ({
  cloudBatchComplete: jest.fn(),
  cloudComplete: jest.fn(),
}));
const mockCompleteLocal = jest.fn();
jest.mock('@/lib/llm/completeLocal', () => ({
  completeLocal: (...args: unknown[]) => mockCompleteLocal(...args),
}));
jest.mock('@/lib/database/services/calibration-service', () => ({
  getScoringOverrides: jest.fn().mockResolvedValue({}),
  recordOverrides: jest.fn().mockResolvedValue({ count: 0, notified: false }),
}));
const mockStoreState = { processingMode: 'ON_DEVICE', relevanceV4: false };
jest.mock('@/lib/stores/mera-protocol-store', () => ({
  useMeraProtocolStore: { getState: () => mockStoreState },
}));
const mockWarn = jest.fn();
jest.mock('@/lib/logger', () => ({
  __esModule: true,
  default: { warn: (...a: unknown[]) => mockWarn(...a), info: jest.fn(), error: jest.fn(), debug: jest.fn(), captureException: jest.fn() },
}));
jest.mock('@/lib/news-harness-app/logger-adapter', () => ({
  appHarnessLogger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));
jest.mock('@/lib/database/index', () => {
  const { makeDatabaseMock } = require('@/lib/__test-helpers__/mockDatabase');
  return makeDatabaseMock();
});
jest.mock('@/lib/database/services/topic-service', () => ({ getActive: jest.fn().mockResolvedValue([]) }));
jest.mock('@/lib/database/services/location-service', () => ({ getAll: jest.fn().mockResolvedValue([]) }));
jest.mock('@/lib/database/services/publication-preference-service', () => ({
  getActive: jest.fn().mockResolvedValue([]),
}));
jest.mock('@/lib/database/services/suppression-service', () => ({
  ...jest.requireActual('@/lib/database/services/suppression-service'),
  getActive: jest.fn().mockResolvedValue([]),
}));
jest.mock('@/lib/database/services/fact-service', () => ({ getFacts: jest.fn().mockResolvedValue([]) }));
jest.mock('@/lib/database/services/article-suggestion-service', () => ({
  getFactWeightById: jest.fn().mockResolvedValue(new Map()),
  buildStageCandidateInput: jest.fn(),
}));
jest.mock('@/lib/database/services/story-impression-service', () => ({
  getOpenedSeenSet: jest.fn().mockResolvedValue(new Set()),
}));

import {
  LOCAL_ARTICLES_PER_SCORE_PROMPT,
  LOCAL_SCORE_MAX_TOKENS,
  getScoringLlmPort,
  withLocalScoringOverrides,
} from '../stage-scoring';
import { DEFAULT_HARNESS_CONFIG } from '@/lib/news-harness/core/config';
import {
  CLOUD_RELEVANCE_SYSTEM_PROMPT,
  LOCAL_RELEVANCE_SYSTEM_PROMPT,
} from '@/lib/news-harness/prompts/prompts';
import {
  buildScoreCallForChunk,
  parseBatchRelevanceResponse,
} from '@/lib/news-harness/article-pipeline/scoring';
import { estimateTokens } from '@/lib/llm/tokens';
import { LOCAL_CONTEXT_TOKENS } from '@/lib/mera-protocol-toolkit/core/context-size';

const silentLogger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };

beforeEach(() => {
  mockCompleteLocal.mockReset();
  mockWarn.mockReset();
  mockStoreState.processingMode = 'ON_DEVICE';
});

describe('withLocalScoringOverrides', () => {
  it('routes the local prompt, one article per call, with a small output budget', () => {
    const cfg = withLocalScoringOverrides(DEFAULT_HARNESS_CONFIG);
    expect(cfg.articlePipeline.relevanceSystemPrompt).toBe(LOCAL_RELEVANCE_SYSTEM_PROMPT);
    expect(cfg.articlePipeline.articlesPerScorePrompt).toBe(LOCAL_ARTICLES_PER_SCORE_PROMPT);
    expect(LOCAL_ARTICLES_PER_SCORE_PROMPT).toBe(1);
    expect(cfg.articlePipeline.scoreBatchMaxTokens).toBe(LOCAL_SCORE_MAX_TOKENS);
  });

  it('never edits DEFAULT_HARNESS_CONFIG (the cloud path keeps its prompt)', () => {
    withLocalScoringOverrides(DEFAULT_HARNESS_CONFIG);
    expect(DEFAULT_HARNESS_CONFIG.articlePipeline.relevanceSystemPrompt).toBe(
      CLOUD_RELEVANCE_SYSTEM_PROMPT,
    );
    expect(DEFAULT_HARNESS_CONFIG.articlePipeline.articlesPerScorePrompt).toBe(5);
  });
});

describe('local prompt fits the model context', () => {
  const heavyPersona = Array.from(
    { length: 20 },
    (_, i) => `Fact ${i}: follows local council decisions and school closures in a mid-size city near the coast`,
  );
  const candidate = {
    id: 'a1',
    titleEn: 'Council approves new cycle lanes across the city centre after long consultation',
    descriptionEn: 'x'.repeat(600),
    countryCode: 'NLD',
    publicationName: 'Some Daily',
    languageCode: 'nl',
    relatedFacts: [{ statement: 'Lives in Hoorn, North Holland, Netherlands' }],
  } as any;

  it('a 20-fact persona plus one long article fits with room for the answer', () => {
    const { system, prompt } = buildScoreCallForChunk([candidate], heavyPersona, LOCAL_RELEVANCE_SYSTEM_PROMPT);
    const total = estimateTokens(system) + estimateTokens(prompt) + LOCAL_SCORE_MAX_TOKENS;
    expect(total).toBeLessThan(LOCAL_CONTEXT_TOKENS);
  });

  it('the old routing (cloud prompt, five articles) did NOT fit, which is the bug this pins', () => {
    const { system, prompt } = buildScoreCallForChunk(
      Array(5).fill(candidate),
      heavyPersona,
      CLOUD_RELEVANCE_SYSTEM_PROMPT,
    );
    expect(estimateTokens(system) + estimateTokens(prompt) + 320).toBeGreaterThan(LOCAL_CONTEXT_TOKENS);
  });
});

describe('the local LLM port', () => {
  it('is the port on-device mode gets', async () => {
    mockCompleteLocal.mockResolvedValue('[0.5]');
    await getScoringLlmPort().batchComplete(
      [{ id: 'score:0', system: 's', prompt: 'p', maxTokens: 24, temperature: 0.1 }],
      {},
    );
    expect(mockCompleteLocal).toHaveBeenCalledTimes(1);
  });

  it('tags relevance calls for the speed readout', async () => {
    mockCompleteLocal.mockResolvedValue('[0.62]');
    const [res] = await getScoringLlmPort().batchComplete(
      [{ id: 'score:0', system: 's', prompt: 'p', maxTokens: 24, temperature: 0.1 }],
      {},
    );
    expect(res).toEqual({ id: 'score:0', output: '[0.62]' });
    expect(mockCompleteLocal).toHaveBeenCalledWith(expect.objectContaining({ label: 'relevance' }));
  });

  it('refuses a prompt that cannot fit, fails open and says why', async () => {
    const [res] = await getScoringLlmPort().batchComplete(
      [{ id: 'score:0', system: 'x'.repeat(4 * LOCAL_CONTEXT_TOKENS), prompt: 'p', maxTokens: 24, temperature: 0.1 }],
      {},
    );
    expect(mockCompleteLocal).not.toHaveBeenCalled();
    expect(res.error).toBeDefined();
    expect(res.output).toBe('');
    expect(mockWarn).toHaveBeenCalledWith('local_relevance_prompt_overflow', expect.any(Object));
  });

  it('warns on an empty completion instead of letting it pass silently', async () => {
    mockCompleteLocal.mockResolvedValue('');
    await getScoringLlmPort().batchComplete(
      [{ id: 'score:0', system: 's', prompt: 'p', maxTokens: 24, temperature: 0.1 }],
      {},
    );
    expect(mockWarn).toHaveBeenCalledWith('local_relevance_empty_output', expect.any(Object));
  });
});

describe('decoding the local answer shape', () => {
  const pipe = DEFAULT_HARNESS_CONFIG.articlePipeline;

  it.each([
    ['[0.62]', 0.62],
    ['[0.05]', 0.05],
    [' [0.91] ', 0.91],
  ])('decodes %s', (output, expected) => {
    const [score] = parseBatchRelevanceResponse(output, 1, 'score:0', undefined, pipe, silentLogger as any);
    expect(score).toBeCloseTo(expected, 5);
  });

  it('an empty answer is the fallback, which is what the old overflow produced for every article', () => {
    const [score] = parseBatchRelevanceResponse('', 1, 'score:0', undefined, pipe, silentLogger as any);
    expect(score).toBe(pipe.fallbackRelevance);
  });
});
