// PersonaUpdateAgent.test.ts — unit tests for lib/llm/agents/PersonaUpdateAgent.ts

const mockHandleSaveExtractedFacts = jest.fn();
const mockHandleUpdateUserConfig = jest.fn();
const mockHandleDeleteUserFacts = jest.fn();
const mockHandleIssueWarning = jest.fn();
const mockHandleExplainMera = jest.fn();

jest.mock('../../chat-tools/tool-handlers', () => ({
  handleSaveExtractedFacts: (...args: unknown[]) => mockHandleSaveExtractedFacts(...args),
  handleUpdateUserConfig: (...args: unknown[]) => mockHandleUpdateUserConfig(...args),
  handleDeleteUserFacts: (...args: unknown[]) => mockHandleDeleteUserFacts(...args),
  handleIssueWarning: (...args: unknown[]) => mockHandleIssueWarning(...args),
  handleExplainMera: (...args: unknown[]) => mockHandleExplainMera(...args),
}));

// item 12b / 13 — the two search tools live in their own modules (and pull in
// Apollo / fetch), so they are mocked here exactly like the other handlers.
const mockHandleSearchNews = jest.fn();
const mockHandleWebSearch = jest.fn();

jest.mock('../../chat-tools/news-search-handler', () => ({
  handleSearchNews: (...args: unknown[]) => mockHandleSearchNews(...args),
}));

jest.mock('../../chat-tools/web-search-handler', () => ({
  handleWebSearch: (...args: unknown[]) => mockHandleWebSearch(...args),
}));

const mockGetFacts = jest.fn();

jest.mock('../../database/services/fact-service', () => ({
  getFacts: (...args: unknown[]) => mockGetFacts(...args),
}));

const mockRunCalibration = jest.fn();

jest.mock('../../database/services/calibration-service', () => ({
  runCalibration: (...args: unknown[]) => mockRunCalibration(...args),
}));

// not-interested P4a: PersonaUpdateAgent gained the staged filter-proposal path
// (D6), so three more real modules would otherwise be pulled in — including
// lib/database (a live SQLiteAdapter at import time). Mock scaffold only; no
// pre-existing assertion in this file changed.
const mockGetActiveSuppressions = jest.fn();

jest.mock('../../database/services/suppression-service', () => ({
  getActive: (...args: unknown[]) => mockGetActiveSuppressions(...args),
}));

const mockExecuteProposalActions = jest.fn();

jest.mock('../../chat-tools/proposal-handlers', () => ({
  executeProposalActions: (...args: unknown[]) => mockExecuteProposalActions(...args),
}));

const mockFloatingChatGetState = jest.fn();

jest.mock('../../stores/floating-chat-store', () => ({
  useFloatingChatStore: {
    getState: (...args: unknown[]) => mockFloatingChatGetState(...args),
  },
}));

const mockLogger = { debug: jest.fn(), warn: jest.fn(), error: jest.fn(), info: jest.fn() };

jest.mock('../../logger', () => ({
  __esModule: true,
  default: { warn: jest.fn(), error: jest.fn(), debug: jest.fn(), info: jest.fn() },
}));

const mockBuildPersonaUpdateStaticPrompt = jest.fn();
const mockBuildPersonaUpdateContext = jest.fn();
const mockBuildToolDefinitions = jest.fn();

jest.mock('../../mera-protocol/prompts', () => ({
  buildPersonaUpdateStaticPrompt: (...args: unknown[]) => mockBuildPersonaUpdateStaticPrompt(...args),
  buildPersonaUpdateContext: (...args: unknown[]) => mockBuildPersonaUpdateContext(...args),
  buildToolDefinitions: (...args: unknown[]) => mockBuildToolDefinitions(...args),
}));

const mockAppLanguageGetState = jest.fn();

jest.mock('../../stores/app-language-store', () => ({
  useAppLanguageStore: {
    getState: (...args: unknown[]) => mockAppLanguageGetState(...args),
  },
}));

const mockMeraProtocolGetState = jest.fn();

jest.mock('../../stores/mera-protocol-store', () => ({
  useMeraProtocolStore: {
    getState: (...args: unknown[]) => mockMeraProtocolGetState(...args),
  },
  useUseLegacyPersonaUpdate: jest.fn(),
}));

jest.mock('../../generated/graphql-types', () => ({
  ProcessingMode: {
    OnDevice: 'ON_DEVICE',
    Cloud: 'CLOUD',
  },
}));

jest.mock('../../translation-service', () => ({
  SUPPORTED_LANGUAGES: [
    { code: 'en', name: 'English' },
    { code: 'fr', name: 'French' },
    { code: 'de', name: 'German' },
  ],
}));

import { PersonaUpdateAgent } from '../agents/PersonaUpdateAgent';

function makeAgent(surface: 'ONBOARDING' | 'CONFIG' = 'ONBOARDING') {
  return new PersonaUpdateAgent('user-123', surface);
}

describe('PersonaUpdateAgent', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockAppLanguageGetState.mockReturnValue({ appLanguage: 'en' });
    mockMeraProtocolGetState.mockReturnValue({
      processingMode: 'CLOUD',
    });
    mockBuildPersonaUpdateStaticPrompt.mockReturnValue('static-prompt');
    mockBuildPersonaUpdateContext.mockReturnValue('context-string');
    // Real tool names — executeTool normalises misspellings against THIS list,
    // so a fictional name here would make that repair untestable.
    mockBuildToolDefinitions.mockReturnValue([
      { type: 'function', function: { name: 'saveExtractedFacts' } },
      { type: 'function', function: { name: 'updateUserConfig' } },
      { type: 'function', function: { name: 'deleteUserFacts' } },
      { type: 'function', function: { name: 'issueWarning' } },
      { type: 'function', function: { name: 'runCalibration' } },
    ]);
    mockGetFacts.mockResolvedValue([]);
    // not-interested P4a defaults — no filters, no pending proposal, so every
    // pre-existing expectation observes the same call args as before.
    mockGetActiveSuppressions.mockResolvedValue([]);
    mockFloatingChatGetState.mockReturnValue({ proposal: null });
    mockExecuteProposalActions.mockResolvedValue({
      applied: 1,
      errors: [],
      summaries: ['Hid "celebrity gossip"'],
      changeLogIds: ['log-1'],
    });
  });

  describe('constructor', () => {
    it('generates a deterministic id from userId and surface', () => {
      const agent = makeAgent('ONBOARDING');
      expect(agent.id).toBe('persona-user-123-ONBOARDING');
    });

    it('differs by surface', () => {
      const a = new PersonaUpdateAgent('u', 'ONBOARDING');
      const b = new PersonaUpdateAgent('u', 'CONFIG');
      expect(a.id).not.toBe(b.id);
    });
  });

  describe('buildSystemPrompt', () => {
    it('builds the static prompt with correct params', async () => {
      const agent = makeAgent('ONBOARDING');
      const result = await agent.buildSystemPrompt(false);

      expect(mockBuildPersonaUpdateStaticPrompt).toHaveBeenCalledWith({
        surface: 'ONBOARDING',
        includeToolFormat: false,
        languageName: 'English',
        mode: 'CLOUD', // ProcessingMode.Cloud → 'CLOUD'
      });
      expect(result).toBe('static-prompt');
    });

    it('maps ON_DEVICE processingMode to LOCAL', async () => {
      mockMeraProtocolGetState.mockReturnValue({
        processingMode: 'ON_DEVICE',
      });
      const agent = makeAgent();
      await agent.buildSystemPrompt(true);

      expect(mockBuildPersonaUpdateStaticPrompt).toHaveBeenCalledWith(
        expect.objectContaining({ mode: 'LOCAL' }),
      );
    });

    it('maps CLOUD processingMode to CLOUD', async () => {
      mockMeraProtocolGetState.mockReturnValue({
        processingMode: 'CLOUD',
      });
      const agent = makeAgent();
      await agent.buildSystemPrompt(false);

      expect(mockBuildPersonaUpdateStaticPrompt).toHaveBeenCalledWith(
        expect.objectContaining({ mode: 'CLOUD' }),
      );
    });

    it('resolves language name from appLanguage code', async () => {
      mockAppLanguageGetState.mockReturnValue({ appLanguage: 'fr' });
      const agent = makeAgent();
      await agent.buildSystemPrompt(false);

      expect(mockBuildPersonaUpdateStaticPrompt).toHaveBeenCalledWith(
        expect.objectContaining({ languageName: 'French' }),
      );
    });

    it('defaults to English for unknown language codes', async () => {
      mockAppLanguageGetState.mockReturnValue({ appLanguage: 'zz' });
      const agent = makeAgent();
      await agent.buildSystemPrompt(false);

      expect(mockBuildPersonaUpdateStaticPrompt).toHaveBeenCalledWith(
        expect.objectContaining({ languageName: 'English' }),
      );
    });

    it('caches result and returns early on second call with same params', async () => {
      const agent = makeAgent();
      await agent.buildSystemPrompt(false);
      await agent.buildSystemPrompt(false);

      expect(mockBuildPersonaUpdateStaticPrompt).toHaveBeenCalledTimes(1);
    });

    it('rebuilds when needsToolFormat changes', async () => {
      const agent = makeAgent();
      await agent.buildSystemPrompt(false);
      await agent.buildSystemPrompt(true);

      expect(mockBuildPersonaUpdateStaticPrompt).toHaveBeenCalledTimes(2);
    });

    it('passes includeToolFormat=true for local LLM', async () => {
      const agent = makeAgent();
      await agent.buildSystemPrompt(true);

      expect(mockBuildPersonaUpdateStaticPrompt).toHaveBeenCalledWith(
        expect.objectContaining({ includeToolFormat: true }),
      );
    });
  });

  describe('buildContext', () => {
    it('returns context string from buildPersonaUpdateContext', async () => {
      mockMeraProtocolGetState.mockReturnValue({
        processingMode: 'CLOUD',
      });
      mockGetFacts.mockResolvedValue([
        { id: 'f1', statement: 'I live in Berlin', questionnaireAttribute: 'location' },
      ]);
      const agent = makeAgent();
      const result = await agent.buildContext();

      expect(mockBuildPersonaUpdateContext).toHaveBeenCalledWith(
        expect.objectContaining({ knownFactsList: expect.any(String) }),
      );
      expect(result).toBe('context-string');
    });

    it('formats facts as bullet list in knownFactsList', async () => {
      mockGetFacts.mockResolvedValue([
        { id: 'f1', statement: 'fact one', questionnaireAttribute: 'interest' },
        { id: 'f2', statement: 'fact two', questionnaireAttribute: null },
      ]);
      const agent = makeAgent();
      await agent.buildContext();

      const callArgs = mockBuildPersonaUpdateContext.mock.calls[0][0];
      expect(callArgs.knownFactsList).toContain("'interest': fact one");
      expect(callArgs.knownFactsList).toContain("'other': fact two");
    });

    // not-interested P4a: filters + the in-flight proposal reach <context> so
    // the one-shot LOCAL path can still resolve a confirm.
    it('threads active filters and the pending proposal into the context (CONFIG)', async () => {
      mockGetActiveSuppressions.mockResolvedValue([
        { id: 'sup-1', pattern: 'celebrity gossip', kind: 'keyword', value: null, strength: 0.9 },
      ]);
      mockFloatingChatGetState.mockReturnValue({
        proposal: {
          id: 'p1',
          explanation: 'You asked to hide that.',
          expectedEffects: 'x',
          actions: [{ type: 'retire_suppression', suppressionId: 'sup-1', pattern: 'celebrity gossip' }],
        },
      });
      await makeAgent('CONFIG').buildContext();

      const callArgs = mockBuildPersonaUpdateContext.mock.calls[0][0];
      expect(callArgs.filtersList).toContain('- [sup-1] "celebrity gossip"');
      expect(callArgs.pendingProposal).toContain('remove the filter "celebrity gossip"');
    });

    // not-interested P4a: the filter feature YIELDS to the user's data. When the
    // facts alone leave no room, the agent degrades its own prompt rather than
    // letting the turn overflow (useLocalLLM hard-errors above the budget).
    it('degrades the filter variant and drops the block when the facts leave no room', async () => {
      // Variant-sized system prompts: only `off` is small enough to fit.
      mockBuildPersonaUpdateStaticPrompt.mockImplementation(
        (p: { filterTools?: string }) => (p.filterTools === 'off' ? 'tiny' : 'X'.repeat(12000)),
      );
      mockGetFacts.mockResolvedValue(
        Array.from({ length: 22 }, (_, i) => ({
          id: `f${i}`,
          statement: 'A'.repeat(199),
          questionnaireAttribute: 'location: residence',
        })),
      );
      mockGetActiveSuppressions.mockResolvedValue([
        { id: 'sup-1', pattern: 'celebrity gossip', kind: 'keyword', value: null, strength: 0.9 },
      ]);

      const agent = makeAgent('CONFIG');
      expect(await agent.buildSystemPrompt(true)).toBe('tiny');
      await agent.buildContext();
      expect(mockBuildPersonaUpdateContext.mock.calls[0][0].filtersList).toBeUndefined();
      // …and the cloud tool payload loses the three filter tools too.
      agent.getToolDefinitions();
      expect(mockBuildToolDefinitions).toHaveBeenCalledWith('CONFIG');
    });

    it('does NOT read filters on the ONBOARDING surface', async () => {
      await makeAgent('ONBOARDING').buildContext();
      expect(mockGetActiveSuppressions).not.toHaveBeenCalled();
      expect(mockBuildPersonaUpdateContext.mock.calls[0][0].filtersList).toBeUndefined();
    });

    it('uses "Nothing yet." when facts are empty', async () => {
      mockGetFacts.mockResolvedValue([]);
      const agent = makeAgent();
      await agent.buildContext();

      const callArgs = mockBuildPersonaUpdateContext.mock.calls[0][0];
      expect(callArgs.knownFactsList).toBe('Nothing yet.');
    });

    it('caps facts at MAX_FACTS_IN_CONTEXT (22)', async () => {
      const manyFacts = Array.from({ length: 30 }, (_, i) => ({
        id: `f${i}`,
        statement: `fact ${i}`,
        questionnaireAttribute: 'test',
      }));
      mockGetFacts.mockResolvedValue(manyFacts);
      const agent = makeAgent();
      await agent.buildContext();

      const callArgs = mockBuildPersonaUpdateContext.mock.calls[0][0];
      const lines = callArgs.knownFactsList.split('\n');
      expect(lines.length).toBe(22);
    });

  });

  describe('getToolDefinitions', () => {
    it('delegates to buildToolDefinitions', () => {
      const agent = makeAgent('CONFIG');
      const tools = agent.getToolDefinitions();

      expect(mockBuildToolDefinitions).toHaveBeenCalledWith('CONFIG');
      expect(tools.map((t) => t.function.name)).toContain('saveExtractedFacts');
    });

    // item 13 — the DECLARATION gate. A handler-only check would leave an
    // off-by-default tool sitting in the prompt on every turn.
    it('omits webSearch while the user toggle is off (and with no toggle at all)', () => {
      for (const state of [{ processingMode: 'CLOUD' }, { processingMode: 'CLOUD', webSearchInChat: false }]) {
        mockMeraProtocolGetState.mockReturnValue(state);
        const names = makeAgent('CONFIG').getToolDefinitions().map((t) => t.function.name);
        expect(names).not.toContain('webSearch');
        // ...while the ungated news search is always there on CLOUD.
        expect(names).toContain('searchNews');
      }
    });

    it('declares webSearch once the user toggle is on', () => {
      mockMeraProtocolGetState.mockReturnValue({ processingMode: 'CLOUD', webSearchInChat: true });
      const names = makeAgent('CONFIG').getToolDefinitions().map((t) => t.function.name);
      expect(names).toContain('webSearch');
    });
  });

  // The forced pass runs with tool_choice:'required', so anything listed here
  // can be called on a turn the user asked nothing of. Both new search tools
  // must stay out of it — a forced `webSearch` would send a query the user
  // never typed, and a forced `searchNews` would burn a round trip on nothing.
  describe('getForcedExtractionTools', () => {
    it('is saveExtractedFacts and nothing else, even with web search enabled', () => {
      mockMeraProtocolGetState.mockReturnValue({ processingMode: 'CLOUD', webSearchInChat: true });
      const names = makeAgent('CONFIG').getForcedExtractionTools().map((t) => t.function.name);
      expect(names).toEqual(['saveExtractedFacts']);
    });
  });

  describe('executeTool', () => {
    it('calls handleSaveExtractedFacts for saveExtractedFacts', async () => {
      mockHandleSaveExtractedFacts.mockResolvedValue({ saved: 1 });
      const agent = makeAgent();
      const result = await agent.executeTool('saveExtractedFacts', { facts: [] });

      expect(mockHandleSaveExtractedFacts).toHaveBeenCalledWith({ facts: [] });
      expect(result.result).toEqual({ saved: 1 });
    });

    it('normalizes saveExtractedsFacts typo to saveExtractedFacts', async () => {
      mockHandleSaveExtractedFacts.mockResolvedValue({ saved: 1 });
      const agent = makeAgent();
      await agent.executeTool('saveExtractedsFacts', { facts: [] });

      expect(mockHandleSaveExtractedFacts).toHaveBeenCalled();
    });

    it('calls handleExplainMera for explainMera', async () => {
      mockHandleExplainMera.mockResolvedValue({ sections: [] });
      const agent = makeAgent();
      const result = await agent.executeTool('explainMera', { topics: ['known_gaps'] });

      expect(mockHandleExplainMera).toHaveBeenCalledWith({ topics: ['known_gaps'] });
      expect(result.result).toEqual({ sections: [] });
    });

    it('calls handleSearchNews for searchNews', async () => {
      mockHandleSearchNews.mockResolvedValue({ articles: [] });
      const agent = makeAgent();
      const result = await agent.executeTool('searchNews', { query: 'floods' });

      expect(mockHandleSearchNews).toHaveBeenCalledWith({ query: 'floods' });
      expect(result.result).toEqual({ articles: [] });
    });

    // item 13 — the REPLAY path, which is the whole reason the handler carries
    // its own gate. With the toggle off the tool is NOT declared, so
    // normalizeToolName finds no match and the raw name falls through to the
    // static `case 'webSearch'`. Execution therefore still reaches the handler,
    // and only the handler's own re-check can stop the query leaving the device.
    it('routes an UNDECLARED webSearch call to the handler anyway (persisted replay)', async () => {
      mockMeraProtocolGetState.mockReturnValue({ processingMode: 'CLOUD', webSearchInChat: false });
      mockHandleWebSearch.mockResolvedValue({ error: 'off', searched: false });
      const agent = makeAgent('CONFIG');

      expect(agent.getToolDefinitions().map((t) => t.function.name)).not.toContain('webSearch');

      const result = await agent.executeTool('webSearch', { query: 'anything' });
      expect(mockHandleWebSearch).toHaveBeenCalledWith({ query: 'anything' });
      expect(result.result).toEqual({ error: 'off', searched: false });
    });

    it('calls handleUpdateUserConfig for updateUserConfig', async () => {
      mockHandleUpdateUserConfig.mockResolvedValue({ updated: true });
      const agent = makeAgent();
      const result = await agent.executeTool('updateUserConfig', { key: 'val' });

      expect(mockHandleUpdateUserConfig).toHaveBeenCalledWith({ key: 'val' });
      expect(result.result).toEqual({ updated: true });
    });

    it('calls handleDeleteUserFacts for deleteUserFacts', async () => {
      mockHandleDeleteUserFacts.mockResolvedValue({ deleted: 2 });
      const agent = makeAgent();
      const result = await agent.executeTool('deleteUserFacts', { ids: ['f1'] });

      expect(mockHandleDeleteUserFacts).toHaveBeenCalledWith({ ids: ['f1'] });
      expect(result.result).toEqual({ deleted: 2 });
    });

    describe('issueWarning', () => {
      it('returns result without sideEffects when blocked is not true', async () => {
        mockHandleIssueWarning.mockResolvedValue({ message: 'noted', blocked: false });
        const agent = makeAgent();
        const result = await agent.executeTool('issueWarning', { reason: 'bad' });

        expect(result.sideEffects).toBeUndefined();
        expect(result.result).toEqual({ message: 'noted', blocked: false });
      });

      it('returns sideEffects.blocked when result.blocked===true', async () => {
        mockHandleIssueWarning.mockResolvedValue({
          blocked: true,
          message: 'User is blocked',
        });
        const agent = makeAgent();
        const result = await agent.executeTool('issueWarning', { reason: 'spam' });

        expect(result.sideEffects?.blocked?.reason).toBe('User is blocked');
      });

      it('uses fallback message when result.message is undefined', async () => {
        mockHandleIssueWarning.mockResolvedValue({ blocked: true });
        const agent = makeAgent();
        const result = await agent.executeTool('issueWarning', {});

        expect(result.sideEffects?.blocked?.reason).toBe('Blocked due to repeated warnings');
      });
    });

    describe('runCalibration (stages, never executes)', () => {
      // Consent moved from the model's reading of a message to a UI tap.
      // Measured 2026-08-03 against the real gateway: with the invitation in
      // history, a bare "thanks!" produced this call 20/20 times, and an
      // explicit "confirmation only" <context> block did not change that.
      it('stages a run_calibration proposal instead of recalibrating', async () => {
        const agent = makeAgent();
        const result = await agent.executeTool('runCalibration', {});

        expect(mockRunCalibration).not.toHaveBeenCalled();
        expect(result.result).toMatchObject({ staged: true });
        expect(result.sideEffects?.proposal?.actions).toEqual([{ type: 'run_calibration' }]);
      });

      it('refuses to apply its own proposal — only a tap can', async () => {
        mockFloatingChatGetState.mockReturnValue({
          proposal: { id: 'p-1', explanation: 'e', expectedEffects: 'x', actions: [{ type: 'run_calibration' }] },
        });
        const agent = makeAgent();
        const result = await agent.executeTool('applyProposal', {});

        // The second half of the guarantee: staging would be pointless if the
        // model could then decide the user said yes and apply it.
        expect(mockExecuteProposalActions).not.toHaveBeenCalled();
        expect(mockRunCalibration).not.toHaveBeenCalled();
        expect(result.result).toMatchObject({ applied: 0, awaitingUserConfirmation: true });
        // The card must survive so the user can still tap it.
        expect(result.sideEffects?.proposalResolved).toBeUndefined();
      });

      it('still applies the OTHER actions in a mixed proposal', async () => {
        mockFloatingChatGetState.mockReturnValue({
          proposal: {
            id: 'p-2', explanation: 'e', expectedEffects: 'x',
            actions: [{ type: 'run_calibration' }, { type: 'add_suppression', suppressionPattern: 'gossip' }],
          },
        });
        const agent = makeAgent();
        const result = await agent.executeTool('applyProposal', {});

        expect(mockExecuteProposalActions).toHaveBeenCalledWith([
          { type: 'add_suppression', suppressionPattern: 'gossip' },
        ]);
        expect(result.result).toMatchObject({ awaitingUserConfirmation: true });
        expect(result.sideEffects?.proposalResolved).toBeUndefined();
      });

      // G1: the floating-chat store holds ONE global proposal, shared with the
      // article / follow-story surfaces. This agent's own proposeChanges cannot
      // set choose_one today, so this guard is defence-in-depth — the sibling
      // call site shipped without it and applied every alternative at once.
      it('refuses a SINGLE-SELECT proposal it did not stage', async () => {
        mockFloatingChatGetState.mockReturnValue({
          proposal: {
            id: 'p-choose', explanation: 'e', expectedEffects: 'x', chooseOne: true,
            actions: [
              { type: 'set_topic_weight', topicText: 'cricket', delta: -0.3 },
              { type: 'retire_topic', topicText: 'cricket' },
            ],
          },
        });
        const result = await makeAgent().executeTool('applyProposal', {});

        expect(mockExecuteProposalActions).not.toHaveBeenCalled();
        expect(result.result).toMatchObject({ applied: 0, awaitingUserConfirmation: true });
        // Card survives — the pills stay tappable.
        expect(result.sideEffects?.proposalResolved).toBeUndefined();
      });
    });

    // --- not-interested P4a (D6): the staged filter-proposal path ---

    it('proposeChanges stages a filter proposal against the ACTIVE filters', async () => {
      mockGetActiveSuppressions.mockResolvedValue([
        { id: 'sup-1', pattern: 'celebrity gossip', kind: 'keyword', value: null, strength: 0.9 },
      ]);
      const agent = makeAgent('CONFIG');
      const result = await agent.executeTool('proposeChanges', {
        explanation: 'You want that gone.',
        expected_effects: 'It stops showing up.',
        actions: [{ type: 'retire_suppression', suppressionId: 'sup-1' }],
      });

      expect(result.result.staged).toBe(true);
      expect(result.sideEffects?.proposal?.actions[0]).toEqual({
        type: 'retire_suppression',
        suppressionId: 'sup-1',
        pattern: 'celebrity gossip',
      });
    });

    it('proposeChanges never reads filters on ONBOARDING (no feed to filter yet)', async () => {
      const agent = makeAgent('ONBOARDING');
      const result = await agent.executeTool('proposeChanges', {
        explanation: 'e',
        expected_effects: 'x',
        actions: [{ type: 'retire_suppression', suppressionId: 'sup-1' }],
      });

      expect(mockGetActiveSuppressions).not.toHaveBeenCalled();
      expect(result.result.error).toContain('unknown suppressionId');
    });

    it('proposeChanges survives a suppression-service failure', async () => {
      mockGetActiveSuppressions.mockRejectedValue(new Error('db down'));
      const agent = makeAgent('CONFIG');
      const result = await agent.executeTool('proposeChanges', {
        explanation: 'e',
        expected_effects: 'x',
        actions: [{ type: 'add_suppression', suppressionPattern: 'celebrity gossip' }],
      });
      expect(result.result.staged).toBe(true);
    });

    it('applyProposal runs the shared executor and reports the resolution', async () => {
      const proposal = {
        id: 'p1',
        explanation: 'e',
        expectedEffects: 'x',
        actions: [{ type: 'add_suppression', suppressionPattern: 'celebrity gossip' }],
      };
      mockFloatingChatGetState.mockReturnValue({ proposal });
      const agent = makeAgent('CONFIG');
      const result = await agent.executeTool('applyProposal', {});

      expect(mockExecuteProposalActions).toHaveBeenCalledWith(proposal.actions);
      expect(result.result.applied).toBe(1);
      expect(result.sideEffects?.proposalResolved).toBe('applied');
    });

    it('applyProposal errors when nothing is pending', async () => {
      mockFloatingChatGetState.mockReturnValue({ proposal: null });
      const result = await makeAgent('CONFIG').executeTool('applyProposal', {});
      expect(result.result).toEqual({ error: 'no pending proposal' });
      expect(mockExecuteProposalActions).not.toHaveBeenCalled();
    });

    it('cancelProposal resolves the proposal without executing anything', async () => {
      const result = await makeAgent('CONFIG').executeTool('cancelProposal', {});
      expect(result.result).toEqual({ cancelled: true });
      expect(result.sideEffects?.proposalResolved).toBe('cancelled');
      expect(mockExecuteProposalActions).not.toHaveBeenCalled();
    });

    it('returns error for unknown tool names', async () => {
      const agent = makeAgent();
      const result = await agent.executeTool('unknownTool', {});

      expect(result.result).toEqual({ error: 'Unknown tool: unknownTool' });
    });

    it('handles null/undefined input gracefully (covers ?? {} fallback)', async () => {
      mockHandleSaveExtractedFacts.mockResolvedValue({ saved: 0 });
      const agent = makeAgent();
      // Pass null as input — exercises the `?? {}` fallback on line 194
      const result = await agent.executeTool('saveExtractedFacts', null as unknown as Record<string, unknown>);
      expect(result.result).toEqual({ saved: 0 });
      expect(mockHandleSaveExtractedFacts).toHaveBeenCalledWith({});
    });
  });
});
