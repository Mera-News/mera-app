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
  FILTERS_BLOCK_TOKEN_CEILING,
  KNOWLEDGE_TOOL_NAMES,
  MERA_EXPLAINER_TOPIC_IDS,
  MAX_FACTS_IN_CONTEXT,
  MAX_FILTERS_IN_CONTEXT,
  PERSONA_INPUT_TOKEN_BUDGET,
  PERSONA_TURN_RESERVE_TOKENS,
  planPersonaPrompt,
  type ContextFact,
} from '../persona-management/persona-agent-core';
import { estimateTokens } from '@/lib/llm/tokens';
import type { ActiveSuppressionView, StagedProposal } from '../core/types';
import {
  buildToolDefinitions,
  buildPersonaUpdateStaticPrompt,
  DEEP_EXAMPLE_QUESTIONS,
  type FilterToolsVariant,
} from '../prompts/prompts';

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
function worstCaseSystemPrompt(
  filterTools: FilterToolsVariant = 'full',
  deepMode = false,
): string {
  return buildPersonaSystemPrompt({
    surface: 'CONFIG',
    includeToolFormat: true,
    languageName: 'French',
    mode: 'LOCAL',
    filterTools,
    ...(deepMode ? { deepMode: true } : {}),
  });
}

/**
 * The PRE-P4a worst case, measured on 647bffb: the CONFIG/LOCAL/XML system
 * prompt (1497) + <context> at 22 facts of the prompt's own 199-char limit
 * (1511) = 3008, which fit the 3072 budget with 64 to spare. This wave must not
 * make that user's turn cost MORE — over budget, useLocalLLM does not degrade,
 * it hard-errors with "Context too long".
 */
const PRE_WAVE_WORST_CASE_TOKENS = 3008;

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
      },
      mockBuild,
    );

    expect(mockBuild).toHaveBeenCalledWith({
      surface: 'ONBOARDING',
      includeToolFormat: true,
      languageName: 'French',
      mode: 'CLOUD',
    });
    expect(result).toBe('built-prompt');
  });

  it('defaults to the real harness builder when no override is passed', () => {
    const result = buildPersonaSystemPrompt({
      surface: 'CONFIG',
      includeToolFormat: false,
      languageName: 'English',
      mode: 'CLOUD',
    });
    expect(typeof result).toBe('string');
    expect(result.length).toBeGreaterThan(0);
    expect(result).toContain('Mera');
  });
});

describe('buildPersonaContext', () => {
  const facts: ContextFact[] = [{ statement: 'Lives in Berlin', questionnaireAttribute: 'location' }];

  it('calls the injected buildContext with the formatted facts list', () => {
    const mockBuildContext = jest.fn().mockReturnValue('ctx-string');
    const result = buildPersonaContext({ facts }, { buildContext: mockBuildContext });

    expect(mockBuildContext).toHaveBeenCalledWith({
      knownFactsList: "- 'location': Lives in Berlin",
    });
    expect(result).toBe('ctx-string');
  });

  it('defaults to the real harness builders when no deps are passed', () => {
    const result = buildPersonaContext({ facts: [] });
    expect(result).toContain('Nothing yet.');
    expect(result).toContain('<context>');
  });
});

describe('getPersonaToolDefinitions', () => {
  it('calls the injected builder with the surface', () => {
    const mockBuildDefs = jest.fn().mockReturnValue([{ type: 'function', function: { name: 'x' } }]);
    const result = getPersonaToolDefinitions('CONFIG', mockBuildDefs as never);

    expect(mockBuildDefs).toHaveBeenCalledWith('CONFIG');
    // The builder's own output passes through untouched; the CLOUD-only
    // knowledge tool is APPENDED here (it is not built by buildToolDefinitions,
    // so the LOCAL XML prompt block derived from that builder gains no bytes).
    expect(result[0]).toEqual({ type: 'function', function: { name: 'x' } });
    // `webSearch` is absent: it is gated on the user's toggle, which defaults
    // to false — see the "web search is off by default" block below.
    expect(result.map((d) => d.function.name)).toEqual(['x', 'explainMera', 'searchNews']);
  });

  // The LOCAL path executes tools but never pushes a role:'tool' message back to
  // the model, so a knowledge tool there is called and never read.
  describe('explainMera (knowledge tool)', () => {
    it('is present on CLOUD, for BOTH surfaces', () => {
      for (const surface of ['ONBOARDING', 'CONFIG'] as const) {
        const names = getPersonaToolDefinitions(surface, buildToolDefinitions, 'full', 'CLOUD')
          .map((d) => d.function.name);
        expect(names).toContain('explainMera');
      }
    });

    it('is absent on LOCAL, for BOTH surfaces', () => {
      for (const surface of ['ONBOARDING', 'CONFIG'] as const) {
        const names = getPersonaToolDefinitions(surface, buildToolDefinitions, 'full', 'LOCAL')
          .map((d) => d.function.name);
        expect(names).not.toContain('explainMera');
      }
    });

    it('defaults to CLOUD when no mode is passed', () => {
      const names = getPersonaToolDefinitions('ONBOARDING').map((d) => d.function.name);
      expect(names).toContain('explainMera');
    });

    it('survives the `off` filter rung — it is not a filter tool', () => {
      const names = getPersonaToolDefinitions('CONFIG', buildToolDefinitions, 'off', 'CLOUD')
        .map((d) => d.function.name);
      expect(names).toContain('explainMera');
      expect(names).not.toContain('proposeChanges');
    });

    it('advertises exactly the shipped topic ids', () => {
      const def = getPersonaToolDefinitions('ONBOARDING')
        .find((d) => d.function.name === 'explainMera')!;
      const topics = def.function.parameters.properties.topics as { description: string };
      for (const id of MERA_EXPLAINER_TOPIC_IDS) {
        expect(topics.description).toContain(id);
      }
      expect(def.function.parameters.required).toEqual(['topics']);
    });

    it('is a KNOWLEDGE tool — the cloud turn loop keys off this set', () => {
      expect(KNOWLEDGE_TOOL_NAMES.has('explainMera')).toBe(true);
      expect(KNOWLEDGE_TOOL_NAMES.has('saveExtractedFacts')).toBe(false);
    });
  });

  // --- item 12b: searchNews -------------------------------------------------

  describe('searchNews', () => {
    it('is present on CLOUD, for BOTH surfaces, at every filter rung', () => {
      for (const surface of ['ONBOARDING', 'CONFIG'] as const) {
        for (const rung of ['full', 'compact', 'off'] as const) {
          const names = getPersonaToolDefinitions(surface, buildToolDefinitions, rung, 'CLOUD')
            .map((d) => d.function.name);
          expect(names).toContain('searchNews');
        }
      }
    });

    // Same structural argument as explainMera: the LOCAL turn is one-shot (it
    // never pushes a role:'tool' message back), so a search whose results the
    // model can never read is strictly worse than no search — and the LOCAL XML
    // prompt has a hard budget that ERRORS the turn when exceeded.
    it('is absent on LOCAL, for BOTH surfaces', () => {
      for (const surface of ['ONBOARDING', 'CONFIG'] as const) {
        const names = getPersonaToolDefinitions(surface, buildToolDefinitions, 'full', 'LOCAL')
          .map((d) => d.function.name);
        expect(names).not.toContain('searchNews');
      }
    });

    it('takes a required query and is a KNOWLEDGE tool', () => {
      const def = getPersonaToolDefinitions('CONFIG')
        .find((d) => d.function.name === 'searchNews')!;
      expect(def.function.parameters.required).toEqual(['query']);
      expect(KNOWLEDGE_TOOL_NAMES.has('searchNews')).toBe(true);
    });
  });

  // --- item 13: webSearch, gated on the user's toggle -----------------------

  describe('webSearch (declaration gate)', () => {
    // THE privacy default, asserted at the seam: every caller that does not
    // deliberately pass an enabled toggle gets a payload with no web-search
    // tool in it, so an off-by-default feature costs zero prompt tokens.
    it('is ABSENT by default — no argument, and an explicit false', () => {
      for (const surface of ['ONBOARDING', 'CONFIG'] as const) {
        expect(
          getPersonaToolDefinitions(surface).map((d) => d.function.name),
        ).not.toContain('webSearch');
        expect(
          getPersonaToolDefinitions(surface, buildToolDefinitions, 'full', 'CLOUD', false)
            .map((d) => d.function.name),
        ).not.toContain('webSearch');
      }
    });

    it('appears only when the toggle is passed as enabled', () => {
      const names = getPersonaToolDefinitions('CONFIG', buildToolDefinitions, 'full', 'CLOUD', true)
        .map((d) => d.function.name);
      expect(names).toContain('webSearch');
    });

    it('stays absent on LOCAL even when the toggle is on', () => {
      const names = getPersonaToolDefinitions('CONFIG', buildToolDefinitions, 'full', 'LOCAL', true)
        .map((d) => d.function.name);
      expect(names).not.toContain('webSearch');
    });

    it('takes a required query and is a KNOWLEDGE tool', () => {
      const def = getPersonaToolDefinitions('CONFIG', buildToolDefinitions, 'full', 'CLOUD', true)
        .find((d) => d.function.name === 'webSearch')!;
      expect(def.function.parameters.required).toEqual(['query']);
      expect(KNOWLEDGE_TOOL_NAMES.has('webSearch')).toBe(true);
    });
  });

  it('defaults to the real harness builder, including deleteUserFacts + runCalibration for CONFIG', () => {
    const defs = getPersonaToolDefinitions('CONFIG');
    const names = defs.map((d) => d.function.name);
    expect(names).toContain('saveExtractedFacts');
    expect(names).toContain('deleteUserFacts');
    expect(names).toContain('runCalibration');
  });

  it('defaults exclude deleteUserFacts + runCalibration for ONBOARDING', () => {
    const defs = getPersonaToolDefinitions('ONBOARDING');
    const names = defs.map((d) => d.function.name);
    expect(names).not.toContain('deleteUserFacts');
    expect(names).not.toContain('runCalibration');
  });

  // not-interested P4a — contract delta (D6): plain persona chat gains the SAME
  // staged-proposal path the ArticleFeedbackAgent has, so "stop showing me
  // celebrity gossip" works without an article. CONFIG only — onboarding has no
  // feed yet, so there is nothing to filter and nothing to pay tokens for.
  it('exposes the staged filter-proposal tools on CONFIG only', () => {
    const config = getPersonaToolDefinitions('CONFIG').map((d) => d.function.name);
    expect(config).toContain('proposeChanges');
    expect(config).toContain('applyProposal');
    expect(config).toContain('cancelProposal');

    const onboarding = getPersonaToolDefinitions('ONBOARDING').map((d) => d.function.name);
    expect(onboarding).not.toContain('proposeChanges');
    expect(onboarding).not.toContain('applyProposal');
    expect(onboarding).not.toContain('cancelProposal');
  });

  // not-interested P4a — contract delta (D9): this surface has NO article to
  // copy a field value from and nothing to validate one against, so its
  // add_suppression is keyword-only. A structured value minted here could never
  // be corroborated and would silently never fire.
  //
  // source-pref P3 UPDATE: the enum now also carries the two SOURCE actions —
  // at the `full` rung ONLY. The keyword-only clause above is unchanged.
  it('restricts the persona proposeChanges schema to the filter + source actions, keyword-only', () => {
    const propose = getPersonaToolDefinitions('CONFIG')
      .find((d) => d.function.name === 'proposeChanges')!;
    expect(propose.function.parameters.required).toEqual(['explanation', 'expected_effects', 'actions']);
    const items = (propose.function.parameters.properties.actions as {
      items: { properties: Record<string, unknown> };
    }).items;
    expect((items.properties.type as { enum: string[] }).enum).toEqual([
      'add_suppression',
      'retire_suppression',
      'set_publication_pref',
      'set_source_scope_pref',
    ]);
    expect(items.properties.suppressionPattern).toBeDefined();
    expect(items.properties.suppressionStrength).toBeDefined();
    expect(items.properties.suppressionId).toBeDefined();
    expect(items.properties.suppressionKind).toBeUndefined();
    expect(items.properties.suppressionValue).toBeUndefined();
    // source-pref P3.
    expect(items.properties.publicationId).toBeDefined();
    expect(items.properties.scopeCountry).toBeDefined();
    expect(items.properties.publicationPref).toBeDefined();
  });

  // source-pref P3 — the `compact` rung stays EXACTLY the pre-source-pref
  // filter feature: the ~104-token persona headroom does not stretch to
  // carrying the source actions twice, so they ride `full` only. This is the
  // schema half of that decision (the prose half is
  // FILTERS_PROMPT_SECTION_COMPACT, deliberately unchanged).
  it('drops the source actions from the schema at the `compact` rung', () => {
    const propose = buildToolDefinitions('CONFIG', 'compact')
      .find((d) => d.function.name === 'proposeChanges')!;
    const items = (propose.function.parameters.properties.actions as {
      items: { properties: Record<string, unknown> };
    }).items;
    expect((items.properties.type as { enum: string[] }).enum).toEqual([
      'add_suppression',
      'retire_suppression',
    ]);
    expect(items.properties.publicationId).toBeUndefined();
    expect(items.properties.scopeCountry).toBeUndefined();
    expect(items.properties.publicationPref).toBeUndefined();
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
    buildPersonaContext({ facts: [] }, { buildContext: mockBuildContext });
    expect(mockBuildContext).toHaveBeenCalledWith({ knownFactsList: 'Nothing yet.' });
  });

  it('passes filtersList and pendingProposal through when present', () => {
    const mockBuildContext = jest.fn().mockReturnValue('ctx');
    buildPersonaContext(
      {
        facts: [],
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
      suppressions: [{ id: 's1', pattern: 'football' }],
    });
    expect(out).toContain('## YOUR FILTERS');
    expect(out).toContain('retire_suppression removes one by [id]');
  });

  it('DROPS the filters block when the turn plan says it cannot be afforded', () => {
    const mockBuildContext = jest.fn().mockReturnValue('ctx');
    buildPersonaContext(
      {
        facts: saturatedFacts(199),
        suppressions: saturatedFilters(),
        includeFiltersBlock: false,
      },
      { buildContext: mockBuildContext },
    );
    expect(mockBuildContext.mock.calls[0][0].filtersList).toBeUndefined();
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
      suppressions: saturatedFilters(),
    });
    // MEASURED 2026-07-31 (legacy-questionnaire removal): system 1768 +
    // context 1263 = 3031 (41 to spare). The legacy-capable prompt this
    // replaced measured 1786 + 1263 = 3049, so removing the dead branches
    // bought back 18 tokens.
    expect(estimateTokens(system) + estimateTokens(context)).toBeLessThan(INPUT_TOKEN_BUDGET);
  });

  it('pins the marginal cost of the filters block against its named ceiling', () => {
    // This is what MAX_FILTERS_IN_CONTEXT is DERIVED from — the cap is a
    // measurement, not a guess. MEASURED 2026-07-29: 187 tokens for 10 rows.
    const facts = saturatedFacts();
    const without = buildPersonaContext({ facts });
    const withFilters = buildPersonaContext({
      facts,
      suppressions: saturatedFilters(),
    });
    const marginal = estimateTokens(withFilters) - estimateTokens(without);
    expect(marginal).toBeGreaterThan(0);
    expect(marginal).toBeLessThanOrEqual(FILTERS_BLOCK_TOKEN_CEILING);
  });

  // --- The no-regression gate ---------------------------------------------
  //
  // The FILTERS feature yields to the user's data, never the reverse. At the
  // point where a turn cannot afford it, the ladder bottoms out at a prompt
  // BYTE-IDENTICAL to the pre-P4a one — so no user who could hold a persona
  // chat turn before this wave can be locked out by it.

  function planFor(factChars: number, filterCount = MAX_FILTERS_IN_CONTEXT) {
    const facts = saturatedFacts(factChars);
    const block = formatActiveFiltersList(saturatedFilters(filterCount));
    return planPersonaPrompt({
      systemTokensFor: (v) => estimateTokens(worstCaseSystemPrompt(v)),
      baseContextTokens: estimateTokens(formatKnownFactsList(facts)),
      filtersBlockTokens: block ? estimateTokens(block) : 0,
    });
  }

  /** What the planned turn actually costs, worst case (CONFIG/LOCAL/XML). */
  function plannedTotal(factChars: number, filterCount = MAX_FILTERS_IN_CONTEXT) {
    const plan = planFor(factChars, filterCount);
    const facts = saturatedFacts(factChars);
    return (
      estimateTokens(worstCaseSystemPrompt(plan.filterTools))
      + estimateTokens(
        buildPersonaContext({
          facts,
          suppressions: saturatedFilters(filterCount),
          includeFiltersBlock: plan.includeFiltersBlock,
        }),
      )
    );
  }

  it('the `off` rung reproduces the pre-P4a prompt — no filter rules, no filter tools', () => {
    const off = worstCaseSystemPrompt('off');
    expect(off).not.toContain('FILTERS:');
    expect(off).not.toContain('proposeChanges');
    expect(off).not.toContain('applyProposal');
    expect(off).not.toContain('cancelProposal');
    // The rest of the CONFIG prompt is untouched.
    expect(off).toContain('deleteUserFacts');
    expect(off).toContain('runCalibration');
  });

  it('yields the whole feature rather than overflow, at every fact length', () => {
    // 22 facts at the prompt's own 199-char limit: the pre-wave prompt fit with
    // 64 to spare, so the post-wave one must too.
    expect(plannedTotal(199)).toBeLessThanOrEqual(PRE_WAVE_WORST_CASE_TOKENS);
    expect(plannedTotal(199)).toBeLessThan(PERSONA_INPUT_TOKEN_BUDGET);
    expect(planFor(199).filterTools).toBe('off');
    expect(planFor(199).includeFiltersBlock).toBe(false);
  });

  it('degrades in the intended order — block first, then docs, then tools', () => {
    const rungs = [88, 120, 150, 170, 199].map((n) => planFor(n));
    // Never gets richer as the facts grow.
    const rank = (p: { filterTools: string; includeFiltersBlock: boolean }) =>
      p.filterTools === 'full' ? (p.includeFiltersBlock ? 3 : 2) : p.filterTools === 'compact' ? 1 : 0;
    const ranks = rungs.map(rank);
    expect(ranks).toEqual([...ranks].sort((a, b) => b - a));
    // The richest rung is reachable, and so is the poorest.
    expect(ranks[0]).toBe(3);
    expect(ranks[ranks.length - 1]).toBe(0);
    // Every rung stays inside the budget.
    for (const n of [88, 120, 150, 170, 199]) {
      expect(plannedTotal(n)).toBeLessThan(PERSONA_INPUT_TOKEN_BUDGET);
    }
  });

  // --- item 17: deep mode must not cost budget -----------------------------
  //
  // The filters ladder CANNOT rescue a deep-mode user: its last rung still
  // carries the question bank, so a bank that merely APPENDED would push the
  // measured worst case (~3008 of 3072) straight over the line into
  // useLocalLLM's hard error. That is why DEEP_EXAMPLE_QUESTIONS replaces the
  // standard bank rather than extending it — and why this is measured on
  // LOCAL, the path the budget actually governs.
  describe('deep mode (item 17)', () => {
    it('never makes the worst-case LOCAL prompt larger, at any rung', () => {
      for (const rung of ['full', 'compact', 'off'] as const) {
        expect(estimateTokens(worstCaseSystemPrompt(rung, true)))
          .toBeLessThanOrEqual(estimateTokens(worstCaseSystemPrompt(rung, false)));
      }
    });

    it('keeps the saturated worst-case turn inside the budget', () => {
      const facts = saturatedFacts(199);
      const total =
        estimateTokens(worstCaseSystemPrompt('off', true))
        + estimateTokens(formatKnownFactsList(facts));
      expect(total).toBeLessThanOrEqual(PRE_WAVE_WORST_CASE_TOKENS);
      expect(total).toBeLessThan(PERSONA_INPUT_TOKEN_BUDGET);
    });

    it('swaps the question bank rather than appending to it', () => {
      const deep = worstCaseSystemPrompt('full', true);
      expect(deep).toContain('What are you trying to protect your attention from?');
      // A standard-bank question that the deep bank drops.
      expect(deep).not.toContain('Do you follow any sports teams or athletes?');
      // ...and the anchors relevance needs are still asked.
      expect(deep).toContain('Where do you live?');
    });

    // Scope decision, asserted so a future edit cannot quietly promise routing
    // this app does not do: there is no briefing and notifications are an
    // hourly cron, so no question may imply an alert is routed or interrupts.
    // Scoped to the BANK, not the whole prompt: the scope decision is about
    // what deep mode ASKS, and an unrelated future prompt line containing one
    // of these words would otherwise fail here and blame deep mode.
    it('promises no interrupt or briefing routing', () => {
      const bank = DEEP_EXAMPLE_QUESTIONS.join(' ').toLowerCase();
      for (const word of ['interrupt', 'briefing', 'notify', 'notification', 'alert']) {
        expect(bank).not.toContain(word);
      }
    });

    it('is off unless asked for — the default prompt is byte-identical', () => {
      expect(worstCaseSystemPrompt('full', false)).toBe(worstCaseSystemPrompt('full'));
    });
  });

  // item 13 — the web-search prose is the one change in this wave that makes a
  // prompt BIGGER, and it feeds planTurn's systemTokensFor. A CLOUD user with
  // many facts who enables it can therefore drop a filter rung sooner: the
  // ladder working as designed, documented here so the interaction is not
  // rediscovered as a surprise. What must hold is that the poorest rung still
  // fits with the turn reserve applied.
  it('leaves room at the `off` rung on CLOUD even with web-search prose', () => {
    const cloud = (webSearch: boolean) =>
      buildPersonaUpdateStaticPrompt({
        surface: 'CONFIG',
        includeToolFormat: false,
        languageName: 'French',
        mode: 'CLOUD',
        filterTools: 'off',
        ...(webSearch ? { webSearch: true } : {}),
      });
    expect(estimateTokens(cloud(true))).toBeGreaterThan(estimateTokens(cloud(false)));
    expect(estimateTokens(cloud(true)))
      .toBeLessThan(PERSONA_INPUT_TOKEN_BUDGET - PERSONA_TURN_RESERVE_TOKENS);
  });

  it('never picks a rung that would overflow, even with the turn reserve applied', () => {
    const plan = planFor(160);
    const total =
      estimateTokens(worstCaseSystemPrompt(plan.filterTools))
      + estimateTokens(formatKnownFactsList(saturatedFacts(160)))
      + (plan.includeFiltersBlock
        ? estimateTokens(formatActiveFiltersList(saturatedFilters())!)
        : 0);
    expect(total).toBeLessThanOrEqual(PERSONA_INPUT_TOKEN_BUDGET - PERSONA_TURN_RESERVE_TOKENS);
  });

  it('returns the `off` rung rather than throwing when nothing fits at all', () => {
    const plan = planPersonaPrompt({
      systemTokensFor: () => 99_999,
      baseContextTokens: 99_999,
      filtersBlockTokens: 10,
    });
    expect(plan).toEqual({ filterTools: 'off', includeFiltersBlock: false });
  });

  it('skips the block-bearing rung when the user has no filters', () => {
    const measured: string[] = [];
    const plan = planPersonaPrompt({
      systemTokensFor: (v) => { measured.push(v); return 10; },
      baseContextTokens: 10,
      filtersBlockTokens: 0,
    });
    expect(plan).toEqual({ filterTools: 'full', includeFiltersBlock: false });
    expect(measured).toEqual(['full']); // measured exactly once
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

// ---------------------------------------------------------------------------
// source-pref v47 (D5) — the two SOURCE actions.
//
// Two tiers of trust, and the tests exist to pin the difference:
//   - a COUNTRY scope is a closed vocabulary, so resolution alone is the gate;
//   - a NAMED publication is an open one whose matching is exact normalized
//     equality, so it must be corroborated against the user's own data or it
//     mints a row that shows on the Source-preferences screen and never fires.
// ---------------------------------------------------------------------------

describe('decidePersonaProposeChanges — source preferences (D5)', () => {
  /** Names that provably exist in the user's own data (visit history ∪ the
   *  local suggestion cache), normalized the way pubPref matching normalizes. */
  const known = new Set(['the times of india', 'le monde']);

  function stageSource(actions: unknown[], corroboration: ReadonlySet<string> = known) {
    return decidePersonaProposeChanges(
      { explanation: 'You asked for this.', expected_effects: 'Different sources.', actions },
      [],
      corroboration,
    );
  }

  // --- named publication: corroboration ------------------------------------

  it('stages a named publication that EXISTS in the user’s own data', () => {
    const r = stageSource([
      // Cased and spaced differently from the stored key on purpose — matching
      // is normalized, so this must still corroborate.
      { type: 'set_publication_pref', publicationId: '  The   Times of India ', publicationPref: 'boost' },
    ]);
    expect(r.result.staged).toBe(true);
    expect(r.sideEffects!.proposal!.actions[0]).toEqual({
      type: 'set_publication_pref',
      // The user's own spelling is preserved (trimmed) — only the MATCH is
      // normalized.
      publicationId: 'The   Times of India',
      publicationPref: 'boost',
    });
  });

  it('DROPS an invented publication — the exact case a preference could never fire on', () => {
    const r = stageSource([
      { type: 'set_publication_pref', publicationId: 'Times of India Group', publicationPref: 'boost' },
    ]);
    // Nothing staged at all: it was the only action.
    expect(r.sideEffects).toBeUndefined();
    expect(r.result.error).toContain('nothing was staged');
  });

  it('drops ONLY the uncorroborated action when the proposal has others', () => {
    const r = stageSource([
      { type: 'set_publication_pref', publicationId: 'Times of India Group', publicationPref: 'boost' },
      { type: 'set_publication_pref', publicationId: 'Le Monde', publicationPref: 'deprioritize' },
    ]);
    expect(r.sideEffects!.proposal!.actions).toEqual([
      { type: 'set_publication_pref', publicationId: 'Le Monde', publicationPref: 'deprioritize' },
    ]);
  });

  it('corroborates NOTHING when the set is absent — every named proposal drops (safe direction)', () => {
    const r = decidePersonaProposeChanges(
      {
        explanation: 'e',
        expected_effects: 'x',
        actions: [{ type: 'set_publication_pref', publicationId: 'Le Monde', publicationPref: 'boost' }],
      },
      [],
    );
    expect(r.sideEffects).toBeUndefined();
    expect(r.result.error).toContain('nothing was staged');
  });

  it('rejects a malformed publicationPref (a correctable formatting error, not a hallucination)', () => {
    expect(
      stageSource([{ type: 'set_publication_pref', publicationId: 'Le Monde', publicationPref: 'louder' }])
        .result.error,
    ).toContain('publicationPref');
    expect(stageSource([{ type: 'set_publication_pref', publicationPref: 'boost' }]).result.error)
      .toContain('publicationId');
  });

  // --- country scope: closed vocabulary ------------------------------------

  it('resolves a country NAME to its ISO alpha-3 scope token and canonical label', () => {
    const r = stageSource([
      { type: 'set_source_scope_pref', scopeCountry: 'india', publicationPref: 'boost' },
    ]);
    expect(r.sideEffects!.proposal!.actions[0]).toEqual({
      type: 'set_source_scope_pref',
      scopeKind: 'country',
      scopeValue: 'IND',
      label: 'India',
      publicationPref: 'boost',
    });
  });

  it('needs NO corroboration — a country is a closed vocabulary', () => {
    const r = stageSource(
      [{ type: 'set_source_scope_pref', scopeCountry: 'Germany', publicationPref: 'deprioritize' }],
      new Set<string>(),
    );
    expect(r.sideEffects!.proposal!.actions[0]).toMatchObject({ scopeValue: 'DEU', label: 'Germany' });
  });

  it('DROPS a name that is not a country — no dead scope_value is ever minted', () => {
    // A nationality, a region and an outright invention: none resolve.
    for (const scopeCountry of ['Indian', 'Scandinavia', 'Wakanda']) {
      const r = stageSource([{ type: 'set_source_scope_pref', scopeCountry, publicationPref: 'boost' }]);
      expect(r.sideEffects).toBeUndefined();
      expect(r.result.error).toContain('nothing was staged');
    }
  });

  it('rejects mute for a scope — nothing implements a scope exclusion', () => {
    const r = stageSource([
      { type: 'set_source_scope_pref', scopeCountry: 'India', publicationPref: 'mute' },
    ]);
    expect(r.sideEffects).toBeUndefined();
    expect(r.result.error).toContain('cannot be muted');
  });

  it('requires a non-empty scopeCountry', () => {
    expect(stageSource([{ type: 'set_source_scope_pref', publicationPref: 'boost' }]).result.error)
      .toContain('scopeCountry');
  });
});
