// PersonaUpdateAgent: the persona update chat surface. Real stores, real database (facts, filters,
// topics), the real tool handlers and proposal executor, and MSW / the gateway mock behind them.
// Every assertion on "what the agent passed to a handler" became an assertion on the handler's
// observable effect (rows, store, recorded requests).
import { addFact, getFacts } from '@/lib/database/services/fact-service';
import * as suppressionService from '@/lib/database/services/suppression-service';
import { addSuppression, getActive as getActiveFilters } from '@/lib/database/services/suppression-service';
import { getActive as getActiveTopics } from '@/lib/database/services/topic-service';
import { PersonaUpdateAgent } from '@/lib/llm/agents/PersonaUpdateAgent';
import { useMeraProtocolStore } from '@/lib/stores/mera-protocol-store';
import type { StagedProposal } from '@/lib/llm/types';
import { FIXTURE_ACCOUNT, fixture, gatewayCalls, mockGql, server } from '@/test/helpers';
import * as personaPrompts from '@/lib/news-harness/prompts/persona-prompts';
import { setProcessingMode, setWebSearchInChat, until } from '@/test/integration/chat/_helpers';
import { addFactsInOrder, factStatements, resetAgentWorld, seedFactWithTopics, setLanguage, setProposal, toolNames } from './agents-kit';

jest.setTimeout(30_000);

const make = (surface: 'ONBOARDING' | 'CONFIG' = 'ONBOARDING') => new PersonaUpdateAgent('user-123', surface);
const pending = (over: Partial<StagedProposal>): StagedProposal => ({ id: 'p1', explanation: 'e', expectedEffects: 'x', actions: [], ...over });
const filterPatterns = async () => (await getActiveFilters()).map((f) => f.pattern);

// Sentences only one surface (or one mode) of the persona prompt carries.
const ONBOARDING_ONLY = 'Onboard the user';
const CONFIG_ONLY = "Update the user's news profile";
const CLOUD_ONLY = 'Per-turn order';
const LOCAL_ONLY = '## Per turn';
const DEEP_BANK = 'What would you regret not hearing about?';

beforeEach(async () => {
  await resetAgentWorld();
});
afterEach(() => {
  jest.restoreAllMocks();
  server.events.removeAllListeners();
});

describe('constructor', () => {
  it('generates a deterministic id from userId and surface', () => {
    expect(make('ONBOARDING').id).toBe('persona-user-123-ONBOARDING');
  });

  it('differs by surface', () => {
    expect(new PersonaUpdateAgent('u', 'ONBOARDING').id).not.toBe(new PersonaUpdateAgent('u', 'CONFIG').id);
  });

  // The 'CONFIG' pin that outlived the old mock seam: the id carries the surface, and the prompt the
  // agent builds is that surface's.
  it('a CONFIG agent is id-tagged CONFIG and builds the CONFIG surface prompt, not the onboarding one', async () => {
    const config = make('CONFIG');
    const onboarding = make('ONBOARDING');

    expect(config.id).toBe('persona-user-123-CONFIG');
    const configPrompt = await config.buildSystemPrompt(false);
    const onboardingPrompt = await onboarding.buildSystemPrompt(false);

    expect(configPrompt).toContain(CONFIG_ONLY);
    expect(configPrompt).not.toContain(ONBOARDING_ONLY);
    expect(onboardingPrompt).toContain(ONBOARDING_ONLY);
    expect(onboardingPrompt).not.toContain(CONFIG_ONLY);
    // The surface also decides the tools: only CONFIG carries deletion, calibration and the filter tools.
    expect(toolNames(config)).toEqual(expect.arrayContaining(['deleteUserFacts', 'runCalibration', 'proposeChanges', 'applyProposal', 'cancelProposal']));
    expect(toolNames(onboarding)).not.toEqual(expect.arrayContaining(['deleteUserFacts']));
    expect(toolNames(onboarding)).not.toContain('proposeChanges');
  });
});

describe('buildSystemPrompt', () => {
  it('builds the cloud prompt for the surface: English, cloud wording, no tool-format block', async () => {
    const result = await make('ONBOARDING').buildSystemPrompt(false);

    expect(result).toContain(ONBOARDING_ONLY);
    expect(result).toContain('**English**');
    expect(result).toContain(CLOUD_ONLY);
    expect(result).not.toContain('<tool_call>');
  });

  it.each([
    ['stored on', { deepInterview: true }],
    ['stored off', { deepInterview: false }],
    ['never stored', {}],
  ])('always asks the deeper questions (%s)', async (_label, stored) => {
    useMeraProtocolStore.setState(stored as never);
    await setProcessingMode('on-device');

    const prompt = await make().buildSystemPrompt(true);

    expect(prompt).toContain(DEEP_BANK);
  });

  it('asks the deeper questions in the cloud prompt too', async () => {
    expect(await make().buildSystemPrompt(false)).toContain(DEEP_BANK);
  });

  it('maps ON_DEVICE processingMode to the LOCAL prompt', async () => {
    await setProcessingMode('on-device');
    const prompt = await make().buildSystemPrompt(true);
    expect(prompt).toContain(LOCAL_ONLY);
    expect(prompt).not.toContain(CLOUD_ONLY);
  });

  it('maps CLOUD processingMode to the CLOUD prompt', async () => {
    const prompt = await make().buildSystemPrompt(false);
    expect(prompt).toContain(CLOUD_ONLY);
    expect(prompt).not.toContain(LOCAL_ONLY);
  });

  it('resolves language name from appLanguage code', async () => {
    setLanguage('fr');
    expect(await make().buildSystemPrompt(false)).toContain('**French**');
  });

  it('defaults to English for unknown language codes', async () => {
    setLanguage('zz');
    expect(await make().buildSystemPrompt(false)).toContain('**English**');
  });

  // The cache is observed by counting calls into the REAL builder (a spy, no replacement).
  it('caches the prompt: a second call with the same params does not rebuild it', async () => {
    const agent = make();
    const build = jest.spyOn(personaPrompts, 'buildPersonaUpdateStaticPrompt');
    try {
      const first = await agent.buildSystemPrompt(false);
      expect(await agent.buildSystemPrompt(false)).toBe(first);
      expect(build).toHaveBeenCalledTimes(1);
      await agent.buildSystemPrompt(true);
      expect(build).toHaveBeenCalledTimes(2);
    } finally {
      build.mockRestore();
    }
  });

  it('rebuilds when needsToolFormat changes', async () => {
    const agent = make();
    const without = await agent.buildSystemPrompt(false);
    const withFormat = await agent.buildSystemPrompt(true);

    expect(withFormat).not.toBe(without);
    expect(withFormat).toContain('<tool_call>');
  });

  it('passes includeToolFormat=true for local LLM', async () => {
    await setProcessingMode('on-device');
    expect(await make().buildSystemPrompt(true)).toContain('<tool_call>');
  });

  it('rebuilds when the web-search toggle flips, and teaches search only on cloud with it on', async () => {
    const agent = make('CONFIG');
    await setWebSearchInChat(false);
    const off = await agent.buildSystemPrompt(false);
    expect(off).not.toContain('WEB SEARCH');

    await setWebSearchInChat(true);
    const on = await agent.buildSystemPrompt(false);
    expect(on).toContain('WEB SEARCH');

    await setProcessingMode('on-device');
    expect(await agent.buildSystemPrompt(false)).not.toContain('WEB SEARCH');
  });
});

describe('buildContext', () => {
  it('returns a context block holding the known facts', async () => {
    await addFact('I live in Berlin', undefined, { attribute: 'location' });

    const result = await make().buildContext();

    expect(result.startsWith('<context>')).toBe(true);
    expect(result).toContain("- 'location': I live in Berlin");
  });

  it('formats facts as a bullet list: attribute first, "other" when there is none', async () => {
    await addFact('fact one', undefined, { attribute: 'interest' });
    await addFact('fact two');

    const result = await make().buildContext();

    expect(result).toContain("- 'interest': fact one");
    expect(result).toContain("- 'other': fact two");
  });

  // not-interested P4a: filters + the in-flight proposal reach <context> so the one-shot LOCAL path
  // can still resolve a confirm.
  it('threads active filters and the pending proposal into the context (CONFIG)', async () => {
    const filter = await addSuppression({ pattern: 'celebrity gossip', strength: 0.9, source: 'chat' as never });
    setProposal(
      pending({
        id: 'p1',
        explanation: 'You asked to hide that.',
        actions: [{ type: 'retire_suppression', suppressionId: filter.id, pattern: 'celebrity gossip' }],
      }),
    );
    const agent = make('CONFIG');
    await agent.buildSystemPrompt(false);

    const ctx = await agent.buildContext();

    expect(ctx).toContain(`- [${filter.id}] "celebrity gossip"`);
    expect(ctx).toContain('remove the filter "celebrity gossip"');
  });

  // not-interested P4a: the filter feature YIELDS to the user's data. When the facts alone leave no
  // room, the agent degrades its own prompt rather than letting the turn overflow.
  it('degrades the filter variant and drops the block when the facts leave no room', async () => {
    await addSuppression({ pattern: 'celebrity gossip', strength: 0.9, source: 'chat' as never });
    // With room to spare the agent carries the whole feature: filter documentation in the system prompt.
    const roomy = await make('CONFIG').buildSystemPrompt(false);

    for (let i = 0; i < 22; i += 1) await addFact('A'.repeat(199), undefined, { attribute: 'location: residence' });
    const agent = make('CONFIG');
    const squeezed = await agent.buildSystemPrompt(false);
    const ctx = await agent.buildContext();

    expect(squeezed.length).toBeLessThan(roomy.length);
    expect(ctx).not.toContain('YOUR FILTERS');
    // ...and the cloud tool payload loses the three filter tools too.
    const names = toolNames(agent);
    expect(names).not.toContain('proposeChanges');
    expect(names).not.toContain('applyProposal');
    expect(names).not.toContain('cancelProposal');
    // Everything else stays.
    expect(names).toEqual(expect.arrayContaining(['saveExtractedFacts', 'deleteUserFacts', 'runCalibration']));
  });

  it('keeps the filter block and tools when the facts leave room', async () => {
    const filter = await addSuppression({ pattern: 'celebrity gossip', strength: 0.9, source: 'chat' as never });
    await addFact('Lives in Berlin');
    const agent = make('CONFIG');
    await agent.buildSystemPrompt(false);

    expect(await agent.buildContext()).toContain(`[${filter.id}]`);
    expect(toolNames(agent)).toEqual(expect.arrayContaining(['proposeChanges', 'applyProposal', 'cancelProposal']));
  });

  it('does NOT read filters on the ONBOARDING surface', async () => {
    await addSuppression({ pattern: 'celebrity gossip', strength: 0.9, source: 'chat' as never });
    const agent = make('ONBOARDING');
    await agent.buildSystemPrompt(false);

    const ctx = await agent.buildContext();

    expect(ctx).not.toContain('YOUR FILTERS');
    expect(ctx).not.toContain('celebrity gossip');
  });

  it('uses "Nothing yet." when facts are empty', async () => {
    expect(await make().buildContext()).toContain('Nothing yet.');
  });

  it('caps facts at MAX_FACTS_IN_CONTEXT (22), keeping the NEWEST', async () => {
    await addFactsInOrder(Array.from({ length: 30 }, (_, i) => `fact ${i}`), 'test');

    const ctx = await make().buildContext();

    expect(ctx.split('\n').filter((l) => l.startsWith("- 'test': "))).toHaveLength(22);
    expect(ctx).toContain("- 'test': fact 29");
    expect(ctx).toContain("- 'test': fact 8\n");
    expect(ctx).not.toContain("- 'test': fact 7\n");
  });
});

describe('getToolDefinitions', () => {
  it('declares the surface tools for the surface asked', () => {
    const names = toolNames(make('CONFIG'));
    expect(names).toContain('saveExtractedFacts');
    expect(names).toContain('deleteUserFacts');
    expect(toolNames(make('ONBOARDING'))).toContain('saveExtractedFacts');
  });

  // item 13: the DECLARATION gate. A handler-only check would leave an off-by-default tool sitting
  // in the prompt on every turn.
  it('omits webSearch while the user toggle is off', async () => {
    await setWebSearchInChat(false);
    const names = toolNames(make('CONFIG'));
    expect(names).not.toContain('webSearch');
    // ...while the ungated news search is always there on CLOUD.
    expect(names).toContain('searchNews');
  });

  it('declares webSearch once the user toggle is on, and never on-device', async () => {
    await setWebSearchInChat(true);
    expect(toolNames(make('CONFIG'))).toContain('webSearch');

    await setProcessingMode('on-device');
    const names = toolNames(make('CONFIG'));
    expect(names).not.toContain('webSearch');
    expect(names).not.toContain('searchNews');
  });
});

// The forced pass runs with tool_choice:'required', so anything listed here can be called on a turn
// the user asked nothing of. Both search tools must stay out of it: a forced `webSearch` would send
// a query the user never typed.
describe('getForcedExtractionTools', () => {
  it('is saveExtractedFacts and nothing else, even with web search enabled', async () => {
    await setWebSearchInChat(true);
    const names = make('CONFIG').getForcedExtractionTools().map((t) => t.function.name);
    expect(names).toEqual(['saveExtractedFacts']);
  });
});

describe('executeTool', () => {
  it('stages the offered facts for saveExtractedFacts: the handler writes nothing', async () => {
    const result = await make().executeTool('saveExtractedFacts', { extracted_user_information: ['Lives in Porto'] });

    expect(result.result).toMatchObject({ staged: true, factsSaved: 0 });
    expect((result.result.pendingFacts as { options: string[] }[]).map((g) => g.options)).toEqual([['Lives in Porto']]);
    expect(await factStatements()).toEqual([]);
  });

  it('normalizes the saveExtractedsFacts typo to saveExtractedFacts', async () => {
    const result = await make().executeTool('saveExtractedsFacts', { extracted_user_information: ['Lives in Porto'] });
    expect(result.result).toMatchObject({ staged: true });
    expect(result.result.error).toBeUndefined();
  });

  it('answers explainMera from the frozen reference document', async () => {
    const result = await make().executeTool('explainMera', { topics: ['known_gaps'] });
    expect((result.result.sections as { topic: string; text: string }[]).map((s) => s.topic)).toEqual(['known_gaps']);
  });

  it('runs searchNews over GraphQL: only the search words leave the device', async () => {
    const seen: Record<string, unknown>[] = [];
    server.use(
      mockGql('SearchNews', (variables) => {
        seen.push(variables);
        return { searchNews: [] };
      }),
    );

    const result = await make().executeTool('searchNews', { query: 'floods' });

    expect(seen).toEqual([{ query: 'floods', limit: 8 }]);
    expect(result.result).toMatchObject({ articles: [] });
  });

  // item 13: the REPLAY path, which is the whole reason the handler carries its own gate. With the
  // toggle off the tool is NOT declared, so normalizeToolName finds no match and the raw name falls
  // through to the static `case 'webSearch'`. Only the handler's own re-check can stop the query
  // leaving the device.
  it('routes an UNDECLARED webSearch call to the handler anyway (persisted replay), which sends nothing', async () => {
    await setWebSearchInChat(false);
    const agent = make('CONFIG');
    expect(toolNames(agent)).not.toContain('webSearch');

    const result = await agent.executeTool('webSearch', { query: 'anything' });

    expect(result.result).toMatchObject({ searched: false });
    expect(result.result.error as string).toContain('switched off');
    expect(gatewayCalls('web-search')).toEqual([]);
  });

  it('runs a declared webSearch: the query reaches the search route', async () => {
    await setWebSearchInChat(true);
    const result = await make('CONFIG').executeTool('webSearch', { query: 'anything' });
    expect(gatewayCalls('web-search').map((c) => c.messages[0].content)).toEqual(['anything']);
    expect(result.result).toMatchObject({ searched: true });
  });

  it('runs updateUserConfig: answers the language codes and sends them to the server', async () => {
    const seen: Record<string, unknown>[] = [];
    server.use(
      mockGql('UpdateUserConfig', (variables) => {
        seen.push(variables);
        return { updateUserConfig: fixture('persona') };
      }),
    );

    const result = await make().executeTool('updateUserConfig', { language_codes: ['de'] });

    expect(result.result).toEqual({ success: true, language_codes: ['de'] });
    await until(() => seen.length > 0, 3000, 'config mutation');
    expect(seen[0]).toMatchObject({ input: { userId: FIXTURE_ACCOUNT.userId, language_codes: ['de'] } });
  });

  it('runs deleteUserFacts for real: the fact is gone', async () => {
    const keep = await addFact('Plays chess');
    const gone = await addFact('Lives in Berlin');

    const result = await make().executeTool('deleteUserFacts', { fact_ids: [gone.id] });

    expect(result.result).toMatchObject({ success: true, deletedCount: 1 });
    expect((await getFacts()).map((f) => f.id)).toEqual([keep.id]);
  });

  describe('issueWarning', () => {
    const warnWith = (over: Record<string, unknown>) =>
      server.use(mockGql('IssueLlmWarning', () => ({ issueLlmWarning: { ...fixture('persona'), userId: FIXTURE_ACCOUNT.userId, ...over } })));

    it('returns result without sideEffects when blocked is not true', async () => {
      warnWith({ llmWarningCount: 1, blockedByLlm: false });

      const result = await make().executeTool('issueWarning', { reason: 'bad' });

      expect(result.sideEffects).toBeUndefined();
      expect(result.result).toMatchObject({ blocked: false, warningCount: 1, message: 'Warning 1/3 issued: bad' });
    });

    it('returns sideEffects.blocked when the server blocked the user', async () => {
      warnWith({ llmWarningCount: 3, blockedByLlm: true, blockedByLlmReason: 'Server says so' });

      const result = await make().executeTool('issueWarning', { reason: 'spam' });

      // The banner reads the server's own reason, never the model-facing sentence.
      expect(result.sideEffects?.blocked?.reason).toBe('Server says so');
    });

    it('passes an empty reason when the server sent none, so the view shows its translated key', async () => {
      warnWith({ llmWarningCount: 3, blockedByLlm: true, blockedByLlmReason: null });

      const result = await make().executeTool('issueWarning', {});

      expect(result.sideEffects?.blocked?.reason).toBe('');
    });
  });

  describe('runCalibration (stages, never executes)', () => {
    // Consent moved from the model's reading of a message to a UI tap. Measured 2026-08-03 against
    // the real gateway: with the invitation in history, a bare "thanks!" produced this call 20/20
    // times, and an explicit "confirmation only" <context> block did not change that.
    it('stages a run_calibration proposal instead of recalibrating', async () => {
      const result = await make().executeTool('runCalibration', {});

      expect(gatewayCalls()).toEqual([]);
      expect(result.result).toMatchObject({ staged: true });
      expect(result.sideEffects?.proposal?.actions).toEqual([{ type: 'run_calibration' }]);
    });

    it('refuses to apply its own proposal: only a tap can', async () => {
      setProposal(pending({ id: 'p-1', actions: [{ type: 'run_calibration' }] }));

      const result = await make().executeTool('applyProposal', {});

      // The second half of the guarantee: staging would be pointless if the model could then decide
      // the user said yes and apply it.
      expect(gatewayCalls()).toEqual([]);
      expect(result.result).toMatchObject({ applied: 0, awaitingUserConfirmation: true });
      // The card must survive so the user can still tap it.
      expect(result.sideEffects?.proposalResolved).toBeUndefined();
    });

    it('still applies the OTHER actions in a mixed proposal', async () => {
      setProposal(pending({ id: 'p-2', actions: [{ type: 'run_calibration' }, { type: 'add_suppression', suppressionPattern: 'gossip' }] }));

      const result = await make().executeTool('applyProposal', {});

      expect(await filterPatterns()).toEqual(['gossip']);
      expect(gatewayCalls()).toEqual([]);
      expect(result.result).toMatchObject({ awaitingUserConfirmation: true });
      expect(result.sideEffects?.proposalResolved).toBeUndefined();
    });

    // G1: the floating-chat store holds ONE global proposal, shared with the article / follow-story
    // surfaces. This agent's own proposeChanges cannot set choose_one today, so this guard is
    // defence in depth: the sibling call site shipped without it and applied every alternative.
    it('refuses a SINGLE-SELECT proposal it did not stage: the topic is untouched', async () => {
      const { topics } = await seedFactWithTopics('Follows cricket', ['cricket']);
      setProposal(
        pending({
          id: 'p-choose',
          chooseOne: true,
          actions: [
            { type: 'set_topic_weight', topicText: 'cricket', delta: -0.3 },
            { type: 'retire_topic', topicText: 'cricket' },
          ],
        }),
      );

      const result = await make().executeTool('applyProposal', {});

      expect((await getActiveTopics()).map((t) => [t.id, t.weight])).toEqual([[topics[0].topicId, 1]]);
      expect(result.result).toMatchObject({ applied: 0, awaitingUserConfirmation: true });
      // Card survives: the pills stay tappable.
      expect(result.sideEffects?.proposalResolved).toBeUndefined();
    });
  });

  // --- not-interested P4a (D6): the staged filter-proposal path ---

  it('proposeChanges stages a filter proposal against the ACTIVE filters', async () => {
    const filter = await addSuppression({ pattern: 'celebrity gossip', strength: 0.9, source: 'chat' as never });

    const result = await make('CONFIG').executeTool('proposeChanges', {
      explanation: 'You want that gone.',
      expected_effects: 'It stops showing up.',
      actions: [{ type: 'retire_suppression', suppressionId: filter.id }],
    });

    expect(result.result.staged).toBe(true);
    expect(result.sideEffects?.proposal?.actions[0]).toEqual({
      type: 'retire_suppression',
      suppressionId: filter.id,
      pattern: 'celebrity gossip',
    });
    // Staging only: the filter is still active.
    expect(await filterPatterns()).toEqual(['celebrity gossip']);
  });

  it('proposeChanges never reads filters on ONBOARDING (no feed to filter yet), even when one exists', async () => {
    const filter = await addSuppression({ pattern: 'celebrity gossip', strength: 0.9, source: 'chat' as never });

    const result = await make('ONBOARDING').executeTool('proposeChanges', {
      explanation: 'e',
      expected_effects: 'x',
      actions: [{ type: 'retire_suppression', suppressionId: filter.id }],
    });

    expect(result.result.error).toContain('unknown suppressionId');
  });

  it('proposeChanges survives a suppression-service failure', async () => {
    jest.spyOn(suppressionService, 'getActive').mockRejectedValueOnce(new Error('db down'));

    const result = await make('CONFIG').executeTool('proposeChanges', {
      explanation: 'e',
      expected_effects: 'x',
      actions: [{ type: 'add_suppression', suppressionPattern: 'celebrity gossip' }],
    });

    expect(result.result.staged).toBe(true);
  });

  it('applyProposal runs the shared executor and reports the resolution', async () => {
    setProposal(pending({ id: 'p1', actions: [{ type: 'add_suppression', suppressionPattern: 'celebrity gossip' }] }));

    const result = await make('CONFIG').executeTool('applyProposal', {});

    expect(result.result.applied).toBe(1);
    expect(result.sideEffects?.proposalResolved).toBe('applied');
    expect(await filterPatterns()).toEqual(['celebrity gossip']);
  });

  it('applyProposal errors when nothing is pending', async () => {
    setProposal(null);
    const result = await make('CONFIG').executeTool('applyProposal', {});
    expect(result.result).toEqual({ error: 'no pending proposal' });
  });

  it('cancelProposal resolves the proposal without executing anything', async () => {
    setProposal(pending({ actions: [{ type: 'add_suppression', suppressionPattern: 'celebrity gossip' }] }));

    const result = await make('CONFIG').executeTool('cancelProposal', {});

    expect(result.result).toEqual({ cancelled: true });
    expect(result.sideEffects?.proposalResolved).toBe('cancelled');
    expect(await filterPatterns()).toEqual([]);
  });

  it('returns error for unknown tool names', async () => {
    const result = await make().executeTool('unknownTool', {});
    expect(result.result).toEqual({ error: 'Unknown tool: unknownTool' });
  });

  it('handles null input gracefully (the ?? {} fallback): an empty offer, no throw', async () => {
    const result = await make().executeTool('saveExtractedFacts', null as unknown as Record<string, unknown>);
    expect(result.result).toMatchObject({ staged: true, pendingFacts: [] });
  });
});
