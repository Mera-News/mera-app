// persona-agent-core.test.ts — unit tests for
// lib/news-harness/persona-management/persona-agent-core.ts (pure system-prompt /
// context / tool-definition construction for the persona-update agent).

import {
  buildPersonaContext,
  buildPersonaSystemPrompt,
  formatKnownFactsList,
  getPersonaToolDefinitions,
  recomputeQuestionnaireLevel,
  MAX_FACTS_IN_CONTEXT,
  type ContextFact,
} from '../persona-management/persona-agent-core';

describe('MAX_FACTS_IN_CONTEXT', () => {
  it('is 22', () => {
    expect(MAX_FACTS_IN_CONTEXT).toBe(22);
  });
});

describe('formatKnownFactsList', () => {
  it('returns "Nothing yet." for an empty list', () => {
    expect(formatKnownFactsList([])).toBe('Nothing yet.');
  });

  it('formats facts as a bullet list with attribute and statement', () => {
    const facts: ContextFact[] = [
      { statement: 'fact one', questionnaireAttribute: 'interest' },
      { statement: 'fact two', questionnaireAttribute: null },
    ];
    const result = formatKnownFactsList(facts);
    expect(result).toContain("- 'interest': fact one");
    expect(result).toContain("- 'other': fact two");
  });

  it('falls back to "other" when questionnaireAttribute is undefined', () => {
    const facts: ContextFact[] = [{ statement: 'fact', questionnaireAttribute: undefined }];
    expect(formatKnownFactsList(facts)).toBe("- 'other': fact");
  });

  it('caps at MAX_FACTS_IN_CONTEXT, keeping the most recent entries', () => {
    const facts: ContextFact[] = Array.from({ length: 30 }, (_, i) => ({
      statement: `fact ${i}`,
      questionnaireAttribute: 'test',
    }));
    const result = formatKnownFactsList(facts);
    const lines = result.split('\n');
    expect(lines.length).toBe(MAX_FACTS_IN_CONTEXT);
    // Keeps the tail (most recent), drops the head.
    expect(result).not.toContain('fact 0');
    expect(result).toContain('fact 29');
    expect(result).toContain('fact 8'); // first kept index: 30 - 22 = 8
  });

  it('does not truncate when facts are at or below the cap (edge: exactly 22)', () => {
    const facts: ContextFact[] = Array.from({ length: 22 }, (_, i) => ({
      statement: `fact ${i}`,
      questionnaireAttribute: 'test',
    }));
    const result = formatKnownFactsList(facts);
    expect(result.split('\n').length).toBe(22);
    expect(result).toContain('fact 0');
  });
});

describe('buildPersonaSystemPrompt', () => {
  it('calls the injected builder with the exact params object', () => {
    const mockBuild = jest.fn().mockReturnValue('built-prompt');
    const result = buildPersonaSystemPrompt(
      {
        surface: 'ONBOARDING',
        includeToolFormat: true,
        languageName: 'French',
        mode: 'CLOUD',
        useLegacy: false,
      },
      mockBuild,
    );

    expect(mockBuild).toHaveBeenCalledWith({
      surface: 'ONBOARDING',
      includeToolFormat: true,
      languageName: 'French',
      mode: 'CLOUD',
      useLegacy: false,
    });
    expect(result).toBe('built-prompt');
  });

  it('defaults to the real harness builder when no override is passed', () => {
    const result = buildPersonaSystemPrompt({
      surface: 'CONFIG',
      includeToolFormat: false,
      languageName: 'English',
      mode: 'CLOUD',
      useLegacy: false,
    });
    expect(typeof result).toBe('string');
    expect(result.length).toBeGreaterThan(0);
    expect(result).toContain('Mera');
  });
});

describe('recomputeQuestionnaireLevel', () => {
  it('decrements when the previous level is not fully covered, stopping once it is', () => {
    const getKeysForLevel = (level: number) => {
      if (level === 1) return ['key_l1'];
      if (level === 2) return ['key_l2'];
      if (level === 3) return ['key_l3'];
      return [];
    };
    // Level 3 → check level 2 (not covered) → decrement to 2 → check level 1
    // (covered) → break at 2. Then increment-check: level 2 itself not fully
    // covered → stays at 2.
    const result = recomputeQuestionnaireLevel(
      { currentLevel: 3, coveredAttributes: new Set(['key_l1', 'key_l3']) },
      getKeysForLevel,
      3,
    );
    expect(result).toBe(2);
  });

  it('breaks the downgrade loop when the previous level is fully covered', () => {
    const getKeysForLevel = (level: number) => {
      if (level === 2) return ['key_l2'];
      if (level === 3) return ['key_l3'];
      return [];
    };
    const result = recomputeQuestionnaireLevel(
      { currentLevel: 3, coveredAttributes: new Set(['key_l2', 'key_l3']) },
      getKeysForLevel,
      3,
    );
    expect(result).toBe(3);
  });

  it('increments when all current-level keys are covered', () => {
    const getKeysForLevel = (level: number) => {
      if (level === 1) return ['key_l1'];
      if (level === 2) return ['key_l2'];
      return [];
    };
    const result = recomputeQuestionnaireLevel(
      { currentLevel: 1, coveredAttributes: new Set(['key_l1']) },
      getKeysForLevel,
      3,
    );
    expect(result).toBe(2);
  });

  it('does not increment past totalLevels', () => {
    const getKeysForLevel = () => ['always_covered'];
    const result = recomputeQuestionnaireLevel(
      { currentLevel: 3, coveredAttributes: new Set(['always_covered']) },
      getKeysForLevel,
      3,
    );
    expect(result).toBe(3);
  });

  it('stays at level 1 with no coverage and no keys', () => {
    const getKeysForLevel = () => [];
    const result = recomputeQuestionnaireLevel(
      { currentLevel: 1, coveredAttributes: new Set() },
      getKeysForLevel,
      3,
    );
    expect(result).toBe(1);
  });

  it('defaults to the real harness getAttributeKeysForLevel/TOTAL_LEVELS when no overrides are passed', () => {
    // No injected fns — exercises the default-parameter branches directly.
    const result = recomputeQuestionnaireLevel({
      currentLevel: 1,
      coveredAttributes: new Set(),
    });
    expect(typeof result).toBe('number');
    expect(result).toBeGreaterThanOrEqual(1);
  });
});

describe('buildPersonaContext', () => {
  const facts: ContextFact[] = [{ statement: 'Lives in Berlin', questionnaireAttribute: 'location' }];

  it('non-legacy: calls the injected buildContext with useLegacy=false and the formatted facts list', () => {
    const mockBuildContext = jest.fn().mockReturnValue('ctx-string');
    const result = buildPersonaContext(
      { facts, useLegacy: false },
      { buildContext: mockBuildContext },
    );

    expect(mockBuildContext).toHaveBeenCalledWith({
      knownFactsList: "- 'location': Lives in Berlin",
      useLegacy: false,
    });
    expect(result).toBe('ctx-string');
  });

  it('legacy: calls buildGuide with the given level + coverage, and buildContext with the guide output', () => {
    const mockBuildGuide = jest.fn().mockReturnValue('guide-text');
    const mockBuildContext = jest.fn().mockReturnValue('ctx-string-legacy');
    const coveredAttributes = new Set(['location']);

    const result = buildPersonaContext(
      { facts, useLegacy: true, currentLevel: 2, coveredAttributes },
      { buildContext: mockBuildContext, buildGuide: mockBuildGuide, totalLevels: 5 },
    );

    expect(mockBuildGuide).toHaveBeenCalledWith(2, coveredAttributes);
    expect(mockBuildContext).toHaveBeenCalledWith({
      knownFactsList: "- 'location': Lives in Berlin",
      useLegacy: true,
      questionnaireGuide: 'guide-text',
      currentLevel: 2,
      totalLevels: 5,
    });
    expect(result).toBe('ctx-string-legacy');
  });

  it('legacy: defaults currentLevel to 1 and coveredAttributes to empty set when omitted', () => {
    const mockBuildGuide = jest.fn().mockReturnValue('guide-text');
    const mockBuildContext = jest.fn().mockReturnValue('ctx');

    buildPersonaContext(
      { facts, useLegacy: true },
      { buildContext: mockBuildContext, buildGuide: mockBuildGuide },
    );

    expect(mockBuildGuide).toHaveBeenCalledWith(1, new Set());
  });

  it('defaults to the real harness builders when no deps are passed', () => {
    const result = buildPersonaContext({ facts: [], useLegacy: false });
    expect(result).toContain('Nothing yet.');
    expect(result).toContain('<context>');
  });
});

describe('getPersonaToolDefinitions', () => {
  it('calls the injected builder with surface and useLegacy', () => {
    const mockBuildDefs = jest.fn().mockReturnValue([{ type: 'function', function: { name: 'x' } }]);
    const result = getPersonaToolDefinitions('CONFIG', false, mockBuildDefs as never);

    expect(mockBuildDefs).toHaveBeenCalledWith('CONFIG', false);
    expect(result).toEqual([{ type: 'function', function: { name: 'x' } }]);
  });

  it('defaults to the real harness builder, including deleteUserFacts for CONFIG', () => {
    const defs = getPersonaToolDefinitions('CONFIG', false);
    const names = defs.map((d) => d.function.name);
    expect(names).toContain('saveExtractedFacts');
    expect(names).toContain('deleteUserFacts');
  });

  it('defaults exclude deleteUserFacts and advanceQuestionnaireLevel for ONBOARDING + non-legacy', () => {
    const defs = getPersonaToolDefinitions('ONBOARDING', false);
    const names = defs.map((d) => d.function.name);
    expect(names).not.toContain('deleteUserFacts');
    expect(names).not.toContain('advanceQuestionnaireLevel');
  });
});
