// PersonaUpdateAgent.test.ts — unit tests for lib/llm/agents/PersonaUpdateAgent.ts

const mockHandleSaveExtractedFacts = jest.fn();
const mockHandleUpdateUserConfig = jest.fn();
const mockHandleDeleteUserFacts = jest.fn();
const mockHandleIssueWarning = jest.fn();

jest.mock('../../chat-tools/tool-handlers', () => ({
  handleSaveExtractedFacts: (...args: unknown[]) => mockHandleSaveExtractedFacts(...args),
  handleUpdateUserConfig: (...args: unknown[]) => mockHandleUpdateUserConfig(...args),
  handleDeleteUserFacts: (...args: unknown[]) => mockHandleDeleteUserFacts(...args),
  handleIssueWarning: (...args: unknown[]) => mockHandleIssueWarning(...args),
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

    describe('runCalibration', () => {
      it('calls calibrationService.runCalibration and returns outcome + a human summary (applied)', async () => {
        mockRunCalibration.mockResolvedValue({ status: 'applied', applied: { W_TOPIC: 0.1 } });
        const agent = makeAgent();
        const result = await agent.executeTool('runCalibration', {});

        expect(mockRunCalibration).toHaveBeenCalled();
        expect(result.result).toMatchObject({
          status: 'applied',
          summary: expect.stringContaining('applied'),
        });
      });

      it('surfaces a no_change summary', async () => {
        mockRunCalibration.mockResolvedValue({ status: 'no_change' });
        const agent = makeAgent();
        const result = await agent.executeTool('runCalibration', {});
        expect(result.result).toMatchObject({ status: 'no_change' });
        expect(String(result.result.summary)).toMatch(/no changes/i);
      });

      it('surfaces a failed summary', async () => {
        mockRunCalibration.mockResolvedValue({ status: 'failed' });
        const agent = makeAgent();
        const result = await agent.executeTool('runCalibration', {});
        expect(result.result).toMatchObject({ status: 'failed' });
        expect(String(result.result.summary)).toMatch(/could not/i);
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
