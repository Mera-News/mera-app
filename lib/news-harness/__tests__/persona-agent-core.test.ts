// persona-agent-core.test.ts — unit tests for
// lib/news-harness/persona-management/persona-agent-core.ts (pure system-prompt /
// context / tool-definition construction for the persona-update agent).

import {
  buildPersonaContext,
  buildPersonaSystemPrompt,
  decidePersonaProposeChanges,
  formatActiveFiltersList,
  formatKnownFactsList,
  formatPendingProposal,
  getPersonaToolDefinitions,
  recomputeQuestionnaireLevel,
  FILTERS_BLOCK_TOKEN_CEILING,
  MAX_FACTS_IN_CONTEXT,
  MAX_FILTERS_IN_CONTEXT,
  PERSONA_CONTEXT_TOKEN_BUDGET,
  type ContextFact,
} from '../persona-management/persona-agent-core';
import { estimateTokens } from '@/lib/llm/tokens';
import type { ActiveSuppressionView, StagedProposal } from '../core/types';

// --- not-interested P4a fixtures -------------------------------------------

/** A "long" persona fact. 120 chars is this codebase's own notion of one — the
 *  article harness truncates fact statements at FACT_STATEMENT_TRUNC = 120 —
 *  paired with the longest real questionnaire-attribute key. */
const LONG_FACT_CHARS = 120;
const LONG_ATTR = 'location: neighborhood/area, city, and country (preserve specifics)';

function saturatedFacts(chars = LONG_FACT_CHARS): ContextFact[] {
  return Array.from({ length: MAX_FACTS_IN_CONTEXT }, () => ({
    statement: 'A'.repeat(chars),
    questionnaireAttribute: LONG_ATTR,
  }));
}

/** Filters with REAL 16-char WatermelonDB-shaped ids — a short fake id would
 *  understate the per-row cost the budget assertions depend on. */
function saturatedFilters(n = MAX_FILTERS_IN_CONTEXT): ActiveSuppressionView[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `abcdefgh1234567${i % 10}`,
    pattern: 'celebrity gossip and reality television',
    kind: i % 3 === 0 ? ('category' as const) : ('keyword' as const),
    value: i % 3 === 0 ? 'Entertainment' : null,
  }));
}

/** The LARGEST persona system prompt: CONFIG (has the filter tools) + LOCAL
 *  (the path INPUT_TOKEN_BUDGET actually governs) + the XML tool-format block +
 *  a pinned language. */
function worstCaseSystemPrompt(): string {
  return buildPersonaSystemPrompt({
    surface: 'CONFIG',
    includeToolFormat: true,
    languageName: 'French',
    mode: 'LOCAL',
    useLegacy: false,
  });
}

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

  it('defaults to the real harness builder, including deleteUserFacts + runCalibration for CONFIG', () => {
    const defs = getPersonaToolDefinitions('CONFIG', false);
    const names = defs.map((d) => d.function.name);
    expect(names).toContain('saveExtractedFacts');
    expect(names).toContain('deleteUserFacts');
    expect(names).toContain('runCalibration');
  });

  it('defaults exclude deleteUserFacts, advanceQuestionnaireLevel + runCalibration for ONBOARDING + non-legacy', () => {
    const defs = getPersonaToolDefinitions('ONBOARDING', false);
    const names = defs.map((d) => d.function.name);
    expect(names).not.toContain('deleteUserFacts');
    expect(names).not.toContain('advanceQuestionnaireLevel');
    expect(names).not.toContain('runCalibration');
  });

  // not-interested P4a — contract delta (D6): plain persona chat gains the SAME
  // staged-proposal path the ArticleFeedbackAgent has, so "stop showing me
  // celebrity gossip" works without an article. CONFIG only — onboarding has no
  // feed yet, so there is nothing to filter and nothing to pay tokens for.
  it('exposes the staged filter-proposal tools on CONFIG only', () => {
    const config = getPersonaToolDefinitions('CONFIG', false).map((d) => d.function.name);
    expect(config).toContain('proposeChanges');
    expect(config).toContain('applyProposal');
    expect(config).toContain('cancelProposal');

    const onboarding = getPersonaToolDefinitions('ONBOARDING', false).map((d) => d.function.name);
    expect(onboarding).not.toContain('proposeChanges');
    expect(onboarding).not.toContain('applyProposal');
    expect(onboarding).not.toContain('cancelProposal');
  });

  // not-interested P4a — contract delta (D9): this surface has NO article to
  // copy a field value from and nothing to validate one against, so its
  // add_suppression is keyword-only. A structured value minted here could never
  // be corroborated and would silently never fire.
  it('restricts the persona proposeChanges schema to the two filter actions, keyword-only', () => {
    const propose = getPersonaToolDefinitions('CONFIG', false)
      .find((d) => d.function.name === 'proposeChanges')!;
    expect(propose.function.parameters.required).toEqual(['explanation', 'expected_effects', 'actions']);
    const items = (propose.function.parameters.properties.actions as {
      items: { properties: Record<string, unknown> };
    }).items;
    expect((items.properties.type as { enum: string[] }).enum).toEqual([
      'add_suppression',
      'retire_suppression',
    ]);
    expect(items.properties.suppressionPattern).toBeDefined();
    expect(items.properties.suppressionStrength).toBeDefined();
    expect(items.properties.suppressionId).toBeDefined();
    expect(items.properties.suppressionKind).toBeUndefined();
    expect(items.properties.suppressionValue).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// not-interested P4a — "not interested" filters in plain persona chat
// ---------------------------------------------------------------------------

describe('formatActiveFiltersList', () => {
  it('returns undefined when there is nothing to show (zero prompt cost)', () => {
    expect(formatActiveFiltersList(undefined)).toBeUndefined();
    expect(formatActiveFiltersList([])).toBeUndefined();
    expect(formatActiveFiltersList([{ id: '', pattern: 'x' }])).toBeUndefined();
  });

  it('renders [id] + phrase, and the kind only when it is not the default keyword', () => {
    const out = formatActiveFiltersList([
      { id: 'a1', pattern: 'celebrity gossip', kind: 'keyword' },
      { id: 'b2', pattern: 'Entertainment', kind: 'category', value: 'Entertainment' },
      { id: 'c3', pattern: 'no kind at all' },
    ])!;
    expect(out).toContain('- [a1] "celebrity gossip"');
    expect(out).toContain('- [b2] "Entertainment" (category)');
    expect(out).toContain('- [c3] "no kind at all"');
    expect(out).not.toContain('(keyword)');
  });

  it('caps at MAX_FILTERS_IN_CONTEXT', () => {
    const out = formatActiveFiltersList(saturatedFilters(MAX_FILTERS_IN_CONTEXT + 10))!;
    expect(out.split('\n')).toHaveLength(MAX_FILTERS_IN_CONTEXT);
  });

  it('stops emitting rows once FILTERS_BLOCK_TOKEN_CEILING would be crossed', () => {
    // Count alone cannot bound the cost — a long pattern would blow past it.
    const fat = Array.from({ length: MAX_FILTERS_IN_CONTEXT }, (_, i) => ({
      id: `abcdefgh1234567${i}`,
      pattern: 'Z'.repeat(500), // trimmed to 60 chars, still ~22 tokens/row
      kind: 'keyword' as const,
    }));
    const out = formatActiveFiltersList(fat)!;
    expect(estimateTokens(out)).toBeLessThanOrEqual(FILTERS_BLOCK_TOKEN_CEILING);
    expect(out.split('\n').length).toBeLessThan(MAX_FILTERS_IN_CONTEXT);
  });
});

describe('formatPendingProposal', () => {
  const proposal = (actions: StagedProposal['actions']): StagedProposal => ({
    id: 'p1',
    explanation: 'You asked to hide celebrity news.',
    expectedEffects: 'Fewer of those stories.',
    actions,
  });

  it('returns undefined with no proposal or no actions', () => {
    expect(formatPendingProposal(null)).toBeUndefined();
    expect(formatPendingProposal(proposal([]))).toBeUndefined();
  });

  it('renders the explanation and a one-line action summary', () => {
    const out = formatPendingProposal(
      proposal([
        { type: 'add_suppression', suppressionPattern: 'celebrity gossip' },
        { type: 'retire_suppression', suppressionId: 's1', pattern: 'football' },
      ]),
    )!;
    expect(out).toContain('You asked to hide celebrity news.');
    expect(out).toContain('hide "celebrity gossip"');
    expect(out).toContain('remove the filter "football"');
  });
});

describe('buildPersonaContext — filters + pending proposal', () => {
  it('adds neither key when there are no filters and no proposal (pre-P4a call shape)', () => {
    const mockBuildContext = jest.fn().mockReturnValue('ctx');
    buildPersonaContext({ facts: [], useLegacy: false }, { buildContext: mockBuildContext });
    expect(mockBuildContext).toHaveBeenCalledWith({ knownFactsList: 'Nothing yet.', useLegacy: false });
  });

  it('passes filtersList and pendingProposal through when present', () => {
    const mockBuildContext = jest.fn().mockReturnValue('ctx');
    buildPersonaContext(
      {
        facts: [],
        useLegacy: false,
        suppressions: [{ id: 's1', pattern: 'football' }],
        proposal: {
          id: 'p',
          explanation: 'why',
          expectedEffects: 'x',
          actions: [{ type: 'retire_suppression', suppressionId: 's1', pattern: 'football' }],
        },
      },
      { buildContext: mockBuildContext },
    );
    const args = mockBuildContext.mock.calls[0][0];
    expect(args.filtersList).toContain('- [s1] "football"');
    expect(args.pendingProposal).toContain('remove the filter "football"');
  });

  it('renders the block through the real builder', () => {
    const out = buildPersonaContext({
      facts: [],
      useLegacy: false,
      suppressions: [{ id: 's1', pattern: 'football' }],
    });
    expect(out).toContain('## YOUR FILTERS');
    expect(out).toContain('retire_suppression removes one by [id]');
  });

  it('DROPS the filters block once the facts alone exceed PERSONA_CONTEXT_TOKEN_BUDGET', () => {
    // An auxiliary block must never be what pushes a fact-saturated turn over
    // the on-device input budget.
    const mockBuildContext = jest.fn().mockReturnValue('ctx');
    buildPersonaContext(
      { facts: saturatedFacts(199), useLegacy: false, suppressions: saturatedFilters() },
      { buildContext: mockBuildContext },
    );
    expect(mockBuildContext.mock.calls[0][0].filtersList).toBeUndefined();
    // Sanity: that fixture really is over the budget.
    expect(estimateTokens(formatKnownFactsList(saturatedFacts(199))))
      .toBeGreaterThan(PERSONA_CONTEXT_TOKEN_BUDGET);
  });
});

describe('persona prompt token budget', () => {
  // The gate: lib/llm/useLocalLLM.ts caps system + prompt at INPUT_TOKEN_BUDGET
  // = 4096 − 1024 = 3072 and hard-errors the turn above it.
  const INPUT_TOKEN_BUDGET = 3072;

  it('worst-case system + context (22 long facts + filters at cap) fits the budget', () => {
    const system = worstCaseSystemPrompt();
    const context = buildPersonaContext({
      facts: saturatedFacts(),
      useLegacy: false,
      suppressions: saturatedFilters(),
    });
    // MEASURED 2026-07-29: system 1705 + context 1263 = 2968 (104 to spare).
    expect(estimateTokens(system) + estimateTokens(context)).toBeLessThan(INPUT_TOKEN_BUDGET);
  });

  it('pins the marginal cost of the filters block against its named ceiling', () => {
    // This is what MAX_FILTERS_IN_CONTEXT is DERIVED from — the cap is a
    // measurement, not a guess. MEASURED 2026-07-29: 187 tokens for 10 rows.
    const facts = saturatedFacts();
    const without = buildPersonaContext({ facts, useLegacy: false });
    const withFilters = buildPersonaContext({
      facts,
      useLegacy: false,
      suppressions: saturatedFilters(),
    });
    const marginal = estimateTokens(withFilters) - estimateTokens(without);
    expect(marginal).toBeGreaterThan(0);
    expect(marginal).toBeLessThanOrEqual(FILTERS_BLOCK_TOKEN_CEILING);
  });

  it('the filters block contributes nothing at pathological fact lengths', () => {
    // 22 facts at the prompt's own 199-char limit already overflow on their own
    // (a PRE-EXISTING cliff — see the wave report). This wave's block must not
    // be part of that: it self-drops.
    const facts = saturatedFacts(199);
    const without = buildPersonaContext({ facts, useLegacy: false });
    const withFilters = buildPersonaContext({
      facts,
      useLegacy: false,
      suppressions: saturatedFilters(),
    });
    expect(estimateTokens(withFilters) - estimateTokens(without)).toBe(0);
  });
});

describe('decidePersonaProposeChanges', () => {
  const rows: ActiveSuppressionView[] = [{ id: 'sup-1', pattern: 'celebrity gossip' }];

  function stage(actions: unknown[], active: ActiveSuppressionView[] = rows) {
    return decidePersonaProposeChanges(
      { explanation: 'You want less of this.', expected_effects: 'Fewer such stories.', actions },
      active,
    );
  }

  it('requires explanation, expected_effects and a non-empty actions array', () => {
    expect(decidePersonaProposeChanges({}, rows).result.error).toContain('explanation');
    expect(decidePersonaProposeChanges({ explanation: 'e' }, rows).result.error).toContain('expected_effects');
    expect(decidePersonaProposeChanges({ explanation: 'e', expected_effects: 'x' }, rows).result.error)
      .toContain('actions');
  });

  it('stages an add_suppression with its strength', () => {
    const r = stage([{ type: 'add_suppression', suppressionPattern: '  celebrity gossip  ', suppressionStrength: 0.9 }]);
    expect(r.sideEffects!.proposal!.actions[0]).toEqual({
      type: 'add_suppression',
      suppressionPattern: 'celebrity gossip',
      suppressionStrength: 0.9,
    });
    expect(r.result.staged).toBe(true);
  });

  it('DROPS suppressionKind/suppressionValue even when the model sends them (keyword-only surface)', () => {
    const r = stage([{
      type: 'add_suppression',
      suppressionPattern: 'celebrity',
      suppressionKind: 'category',
      suppressionValue: 'celebrity stuff',
    }]);
    expect(r.sideEffects!.proposal!.actions[0]).toEqual({
      type: 'add_suppression',
      suppressionPattern: 'celebrity',
    });
  });

  it('resolves a retire_suppression pattern from OUR list, never from the model', () => {
    const r = stage([{ type: 'retire_suppression', suppressionId: 'sup-1', pattern: 'a lie' }]);
    expect(r.sideEffects!.proposal!.actions[0]).toEqual({
      type: 'retire_suppression',
      suppressionId: 'sup-1',
      pattern: 'celebrity gossip',
    });
  });

  it('rejects an unknown or missing suppressionId, and rejects outright with no filters in context', () => {
    expect(stage([{ type: 'retire_suppression', suppressionId: 'nope' }]).result.error)
      .toContain('unknown suppressionId');
    expect(stage([{ type: 'retire_suppression' }]).result.error).toContain('suppressionId');
    expect(stage([{ type: 'retire_suppression', suppressionId: 'sup-1' }], []).result.error)
      .toContain('unknown suppressionId');
  });

  it('rejects any action type outside the two filter actions', () => {
    expect(stage([{ type: 'delete_fact', fact_id: 'f1' }]).result.error).toContain('invalid action type');
    expect(stage([{ type: 'add_suppression' }]).result.error).toContain('suppressionPattern');
    expect(stage(['not an object']).result.error).toContain('action must be an object');
  });
});
