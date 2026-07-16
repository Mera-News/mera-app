// Pure topic-generation builders + the port-based batch flow.
// No module mocks needed — the harness is dependency-free (prompts are real,
// LLM/persona-store are injected fakes).

import {
  buildBaseUserPrompt,
  splitCount,
  buildCloudBatchCallsForFact,
  mergeRealOutputsForFact,
  mergeTopicsAppend,
  parseTopicsFromOutput,
  generateTopicsForFactsBatch,
} from '../persona-management/topic-generation';
import {
  CLOUD_TOPIC_GENERATION_SYSTEM_PROMPT,
  CLOUD_FACT_COMBO_TOPIC_GENERATION_SYSTEM_PROMPT,
} from '../prompts/prompts';
import { NOOP_LOGGER, type HarnessLogger } from '../core/ports';
import type { Fact } from '../core/types';

function fact(partial: Partial<Fact> & { id: string; statement: string }): Fact {
  return {
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...partial,
  } as Fact;
}

// ---------------------------------------------------------------------------
// splitCount
// ---------------------------------------------------------------------------

describe('splitCount', () => {
  it('gives all to factOnly when there are no other facts', () => {
    expect(splitCount(16, false)).toEqual({ factOnly: 16, combo: 0 });
  });
  it('biases ~60/40 toward factOnly when others exist', () => {
    // 2026-07-16: combo = floor(total*0.4), factOnly = remainder (fact-only is
    // the higher-quality path; combo produced most wasted-quota noise).
    expect(splitCount(10, true)).toEqual({ factOnly: 6, combo: 4 });
    expect(splitCount(16, true)).toEqual({ factOnly: 10, combo: 6 });
    expect(splitCount(15, true)).toEqual({ factOnly: 9, combo: 6 });
  });
});

// ---------------------------------------------------------------------------
// buildBaseUserPrompt
// ---------------------------------------------------------------------------

describe('buildBaseUserPrompt', () => {
  it('emits just the fact when nothing else is provided', () => {
    const p = buildBaseUserPrompt(
      { factStatement: 'Works in AI', userLocation: null, otherFacts: [] },
      false,
    );
    expect(p).toBe('Fact: "Works in AI"');
  });

  it('includes user location when present', () => {
    const p = buildBaseUserPrompt(
      { factStatement: 'Music festivals', userLocation: 'Amsterdam', otherFacts: [] },
      false,
    );
    expect(p).toContain('User location: Amsterdam');
  });

  it('includes other facts only when includeOthers is true', () => {
    const inputs = {
      factStatement: 'Works in AI',
      userLocation: null,
      otherFacts: ['Has kids'],
    };
    expect(buildBaseUserPrompt(inputs, false)).not.toContain('Has kids');
    expect(buildBaseUserPrompt(inputs, true)).toContain('Has kids');
  });

  it('appends excludeTopics when provided', () => {
    const p = buildBaseUserPrompt(
      {
        factStatement: 'Works in AI',
        userLocation: null,
        otherFacts: [],
        excludeTopics: ['AI news'],
      },
      false,
    );
    expect(p).toContain('Do NOT repeat these existing topics');
    expect(p).toContain('AI news');
  });
});

// ---------------------------------------------------------------------------
// buildCloudBatchCallsForFact (default system prompts = real harness prompts)
// ---------------------------------------------------------------------------

describe('buildCloudBatchCallsForFact', () => {
  it('returns one factOnly call with the real cloud topic prompt by default', () => {
    const calls = buildCloudBatchCallsForFact(
      { factStatement: 'Works in AI', userLocation: null, otherFacts: [] },
      'f1',
    );
    expect(calls).toHaveLength(1);
    expect(calls[0].id).toBe('f1:factOnly');
    expect(calls[0].system).toBe(CLOUD_TOPIC_GENERATION_SYSTEM_PROMPT);
    expect(calls[0].temperature).toBe(0.3);
  });

  it('returns factOnly + combo when other facts exist', () => {
    const calls = buildCloudBatchCallsForFact(
      { factStatement: 'Works in AI', userLocation: null, otherFacts: ['Has kids'] },
      'f1',
    );
    expect(calls.map((c) => c.id)).toEqual(['f1:factOnly', 'f1:combo']);
    expect(calls[1].system).toBe(CLOUD_FACT_COMBO_TOPIC_GENERATION_SYSTEM_PROMPT);
  });

  it('honours an injected system-prompt override', () => {
    const calls = buildCloudBatchCallsForFact(
      { factStatement: 'Works in AI', userLocation: null, otherFacts: [] },
      'f1',
      { factOnly: 'OVERRIDE', combo: 'OVERRIDE_COMBO' },
    );
    expect(calls[0].system).toBe('OVERRIDE');
  });
});

// ---------------------------------------------------------------------------
// mergeRealOutputsForFact / mergeTopicsAppend / parseTopicsFromOutput
// ---------------------------------------------------------------------------

describe('mergeRealOutputsForFact', () => {
  it('merges factOnly first, then combo, deduped case-insensitively', () => {
    const out = mergeRealOutputsForFact('["AI news", "ML"]', '["ai news", "startups"]', 'Works in AI');
    expect(out).toEqual(['AI news', 'ML', 'startups']);
  });
  it('returns [] when both are null', () => {
    expect(mergeRealOutputsForFact(null, null, 'x')).toEqual([]);
  });
});

describe('mergeTopicsAppend', () => {
  it('appends new topics, deduped, existing order preserved', () => {
    expect(mergeTopicsAppend(['AI news'], ['ai news', 'ML policy'])).toEqual([
      'AI news',
      'ML policy',
    ]);
  });
});

describe('parseTopicsFromOutput', () => {
  it('parses a JSON array', () => {
    expect(parseTopicsFromOutput('["a", "b"]', 'f')).toEqual(['a', 'b']);
  });
  it('returns [] and warns through the injected logger on unparseable output', () => {
    const warn = jest.fn();
    const logger: HarnessLogger = { ...NOOP_LOGGER, warn };
    expect(parseTopicsFromOutput('nonsense', 'f', logger)).toEqual([]);
    expect(warn).toHaveBeenCalled();
  });
  it('does not throw with the default NOOP logger', () => {
    expect(() => parseTopicsFromOutput('nonsense', 'f')).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// generateTopicsForFactsBatch (port-based)
// ---------------------------------------------------------------------------

function makePorts(overrides: Record<string, unknown> = {}) {
  const updates: { id: string; metadata: Record<string, string[]> }[] = [];
  const ports = {
    llm: {
      batchComplete: jest.fn(async () => [] as { id: string; output: string; error?: string }[]),
      complete: jest.fn(async () => ''),
    },
    personaStore: {
      getFacts: jest.fn(async () => [] as Fact[]),
      updateFactMetadata: jest.fn(async (id: string, metadata: Record<string, string[]>) => {
        updates.push({ id, metadata });
      }),
    },
    ...overrides,
  };
  return { ports, updates };
}

describe('generateTopicsForFactsBatch', () => {
  it('saves merged topics on the happy path (default builder)', async () => {
    const { ports, updates } = makePorts();
    ports.llm.batchComplete.mockResolvedValueOnce([
      { id: 'f1:factOnly', output: '["AI news", "ML policy"]' },
    ]);

    await generateTopicsForFactsBatch(ports, [{ id: 'f1', statement: 'Works in AI' }]);

    expect(ports.llm.batchComplete).toHaveBeenCalled();
    expect(updates).toEqual([{ id: 'f1', metadata: { topics: ['AI news', 'ML policy'] } }]);
  });

  it('records topicGenError when the LLM batch throws', async () => {
    const { ports, updates } = makePorts();
    ports.llm.batchComplete.mockRejectedValueOnce(new Error('network down'));

    await generateTopicsForFactsBatch(ports, [{ id: 'f1', statement: 'Works in AI' }]);

    expect(updates).toEqual([{ id: 'f1', metadata: { topicGenError: ['network down'] } }]);
  });

  it('records topicGenError when no result comes back for a fact', async () => {
    const { ports, updates } = makePorts();
    ports.llm.batchComplete.mockResolvedValueOnce([]);

    await generateTopicsForFactsBatch(ports, [{ id: 'f1', statement: 'Works in AI' }]);

    expect(updates).toEqual([
      { id: 'f1', metadata: { topicGenError: ['No topic-gen result returned'] } },
    ]);
  });

  it('records topicGenError when the output parses to no usable topics', async () => {
    const { ports, updates } = makePorts();
    ports.llm.batchComplete.mockResolvedValueOnce([{ id: 'f1:factOnly', output: 'not json' }]);

    await generateTopicsForFactsBatch(ports, [{ id: 'f1', statement: 'Works in AI' }]);

    expect(updates[0].metadata.topicGenError).toEqual([
      'Topic generation returned no usable topics',
    ]);
  });

  it('resolves user location from facts and passes it to an injected builder', async () => {
    const { ports } = makePorts({
      personaStore: {
        getFacts: jest.fn(async () => [
          fact({
            id: 'loc',
            statement: 'Lives in Amsterdam',
            questionnaireAttribute:
              'location: neighborhood/area, city, and country (preserve specifics)',
          }),
        ]),
        updateFactMetadata: jest.fn(async () => {}),
      },
    });
    const buildCalls = jest.fn(() => []);

    await generateTopicsForFactsBatch(
      { ...ports, buildCalls },
      [{ id: 'f1', statement: 'Works in AI' }],
    );

    expect(buildCalls).toHaveBeenCalledWith(
      expect.objectContaining({ userLocation: 'Lives in Amsterdam', otherFacts: [] }),
      'f1',
    );
  });

  it('runs without throwing when no logger is supplied (NOOP path)', async () => {
    const { ports } = makePorts();
    ports.llm.batchComplete.mockResolvedValueOnce([
      { id: 'f1:factOnly', output: '["AI news"]' },
    ]);
    await expect(
      generateTopicsForFactsBatch(ports, [{ id: 'f1', statement: 'Works in AI' }]),
    ).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// NOOP_LOGGER coverage
// ---------------------------------------------------------------------------

describe('NOOP_LOGGER', () => {
  it('every method is a silent no-op', () => {
    expect(NOOP_LOGGER.debug('x')).toBeUndefined();
    expect(NOOP_LOGGER.info('x')).toBeUndefined();
    expect(NOOP_LOGGER.warn('x')).toBeUndefined();
    expect(NOOP_LOGGER.error('x')).toBeUndefined();
  });
});
