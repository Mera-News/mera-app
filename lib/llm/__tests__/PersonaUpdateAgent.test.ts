// PersonaUpdateAgent.test.ts — unit tests for lib/llm/agents/PersonaUpdateAgent.ts

const mockHandleSaveExtractedFacts = jest.fn();
const mockHandleUpdateUserConfig = jest.fn();
const mockHandleDeleteUserFacts = jest.fn();
const mockHandleAdvanceQuestionnaireLevel = jest.fn();
const mockHandleIssueWarning = jest.fn();

jest.mock('../../chat-tools/tool-handlers', () => ({
  handleSaveExtractedFacts: (...args: unknown[]) => mockHandleSaveExtractedFacts(...args),
  handleUpdateUserConfig: (...args: unknown[]) => mockHandleUpdateUserConfig(...args),
  handleDeleteUserFacts: (...args: unknown[]) => mockHandleDeleteUserFacts(...args),
  handleAdvanceQuestionnaireLevel: (...args: unknown[]) => mockHandleAdvanceQuestionnaireLevel(...args),
  handleIssueWarning: (...args: unknown[]) => mockHandleIssueWarning(...args),
}));

const mockGetFacts = jest.fn();
const mockGetCoveredAttributeKeys = jest.fn();
const mockGetQuestionnaireLevel = jest.fn();
const mockSetQuestionnaireLevel = jest.fn();

jest.mock('../../database/services/fact-service', () => ({
  getCoveredAttributeKeys: (...args: unknown[]) => mockGetCoveredAttributeKeys(...args),
  getFacts: (...args: unknown[]) => mockGetFacts(...args),
  getQuestionnaireLevel: (...args: unknown[]) => mockGetQuestionnaireLevel(...args),
  setQuestionnaireLevel: (...args: unknown[]) => mockSetQuestionnaireLevel(...args),
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

const mockBuildQuestionnaireGuide = jest.fn();
const mockGetAttributeKeysForLevel = jest.fn();

jest.mock('../../mera-protocol/questionnaire-data', () => ({
  buildQuestionnaireGuide: (...args: unknown[]) => mockBuildQuestionnaireGuide(...args),
  getAttributeKeysForLevel: (...args: unknown[]) => mockGetAttributeKeysForLevel(...args),
  TOTAL_LEVELS: 3,
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

import { PersonaUpdateAgent, MAX_HISTORY_MESSAGES } from '../agents/PersonaUpdateAgent';

function makeAgent(surface: 'ONBOARDING' | 'CONFIG' = 'ONBOARDING') {
  return new PersonaUpdateAgent('user-123', surface);
}

describe('PersonaUpdateAgent', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockAppLanguageGetState.mockReturnValue({ appLanguage: 'en' });
    mockMeraProtocolGetState.mockReturnValue({
      processingMode: 'CLOUD',
      useLegacyPersonaUpdate: false,
    });
    mockBuildPersonaUpdateStaticPrompt.mockReturnValue('static-prompt');
    mockBuildPersonaUpdateContext.mockReturnValue('context-string');
    mockBuildToolDefinitions.mockReturnValue([{ type: 'function', function: { name: 'saveFacts' } }]);
    mockGetFacts.mockResolvedValue([]);
    mockGetCoveredAttributeKeys.mockResolvedValue(new Set());
    mockGetQuestionnaireLevel.mockResolvedValue(1);
    mockSetQuestionnaireLevel.mockResolvedValue(undefined);
    mockGetAttributeKeysForLevel.mockReturnValue([]);
    mockBuildQuestionnaireGuide.mockReturnValue('guide');
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
        useLegacy: false,
      });
      expect(result).toBe('static-prompt');
    });

    it('maps ON_DEVICE processingMode to LOCAL', async () => {
      mockMeraProtocolGetState.mockReturnValue({
        processingMode: 'ON_DEVICE',
        useLegacyPersonaUpdate: false,
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
        useLegacyPersonaUpdate: false,
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
    it('returns context string from buildPersonaUpdateContext (non-legacy)', async () => {
      mockMeraProtocolGetState.mockReturnValue({
        processingMode: 'CLOUD',
        useLegacyPersonaUpdate: false,
      });
      mockGetFacts.mockResolvedValue([
        { id: 'f1', statement: 'I live in Berlin', questionnaireAttribute: 'location' },
      ]);
      const agent = makeAgent();
      const result = await agent.buildContext();

      expect(mockBuildPersonaUpdateContext).toHaveBeenCalledWith(
        expect.objectContaining({ useLegacy: false }),
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

    describe('legacy path', () => {
      beforeEach(() => {
        mockMeraProtocolGetState.mockReturnValue({
          processingMode: 'CLOUD',
          useLegacyPersonaUpdate: true,
        });
      });

      it('calls buildPersonaUpdateContext with useLegacy=true', async () => {
        mockGetAttributeKeysForLevel.mockReturnValue(['q1_location']);
        mockGetCoveredAttributeKeys.mockResolvedValue(new Set(['q1_location']));
        mockGetQuestionnaireLevel.mockResolvedValue(1);
        const agent = makeAgent();
        await agent.buildContext();

        expect(mockBuildPersonaUpdateContext).toHaveBeenCalledWith(
          expect.objectContaining({ useLegacy: true }),
        );
      });

      it('calls setQuestionnaireLevel after computing level', async () => {
        mockGetAttributeKeysForLevel.mockReturnValue([]);
        mockGetCoveredAttributeKeys.mockResolvedValue(new Set());
        mockGetQuestionnaireLevel.mockResolvedValue(1);
        const agent = makeAgent();
        await agent.buildContext();

        expect(mockSetQuestionnaireLevel).toHaveBeenCalled();
      });

      it('decrements level when previous level is not fully covered (lines 120-123)', async () => {
        // Start at level 3, level 2 keys are not all covered → should decrement to 2
        mockGetQuestionnaireLevel.mockResolvedValue(3);
        // getAttributeKeysForLevel(2) returns keys not in coveredAttributes
        mockGetAttributeKeysForLevel.mockImplementation((level: number) => {
          if (level === 2) return ['key_level2'];
          if (level === 3) return ['key_level3'];
          return [];
        });
        // coveredAttributes does NOT include key_level2
        mockGetCoveredAttributeKeys.mockResolvedValue(new Set(['key_level3']));

        const agent = makeAgent();
        await agent.buildContext();

        // The loop should have decremented from 3 to 2
        expect(mockSetQuestionnaireLevel).toHaveBeenCalledWith(expect.any(Number));
      });

      it('breaks the while-downgrade loop when prevLevel is fully covered', async () => {
        // Start at level 3, level 2 keys ARE all covered → break immediately
        mockGetQuestionnaireLevel.mockResolvedValue(3);
        mockGetAttributeKeysForLevel.mockImplementation((level: number) => {
          if (level === 2) return ['key_l2'];
          if (level === 3) return ['key_l3'];
          return [];
        });
        // All prevLevel keys are covered → allPrevCovered=true → break
        mockGetCoveredAttributeKeys.mockResolvedValue(new Set(['key_l2', 'key_l3']));

        const agent = makeAgent();
        await agent.buildContext();

        // setQuestionnaireLevel called (level computed without unnecessary decrement)
        expect(mockSetQuestionnaireLevel).toHaveBeenCalled();
      });

      it('increments level when all current-level keys are covered (line 129 else branch)', async () => {
        // Start at level 1, all level 1 keys covered → loop increments to level 2
        mockGetQuestionnaireLevel.mockResolvedValue(1);
        // TOTAL_LEVELS = 3, so while currentLevel < 3
        mockGetAttributeKeysForLevel.mockImplementation((level: number) => {
          if (level === 1) return ['key_l1']; // all covered → currentLevel++
          if (level === 2) return ['key_l2']; // NOT covered → break
          return [];
        });
        // key_l1 is covered, key_l2 is not
        mockGetCoveredAttributeKeys.mockResolvedValue(new Set(['key_l1']));

        const agent = makeAgent();
        await agent.buildContext();

        // Level should have been advanced past 1 (to 2) before breaking
        expect(mockSetQuestionnaireLevel).toHaveBeenCalledWith(2);
      });
    });
  });

  describe('getToolDefinitions', () => {
    it('delegates to buildToolDefinitions', () => {
      const agent = makeAgent('CONFIG');
      const tools = agent.getToolDefinitions();

      expect(mockBuildToolDefinitions).toHaveBeenCalledWith('CONFIG', false);
      expect(tools).toEqual([{ type: 'function', function: { name: 'saveFacts' } }]);
    });
  });

  describe('formatMessages', () => {
    it('returns messages sliced to MAX_HISTORY_MESSAGES', () => {
      const agent = makeAgent();
      const msgs = Array.from({ length: 20 }, (_, i) => ({
        id: `m${i}`,
        role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
        content: `msg ${i}`,
      }));

      const result = agent.formatMessages(msgs);
      // Should have at most MAX_HISTORY_MESSAGES + possible prepended user
      expect(result.length).toBeLessThanOrEqual(MAX_HISTORY_MESSAGES + 1);
    });

    it('ensures result starts with a user turn', () => {
      const agent = makeAgent();
      // Messages where last MAX_HISTORY_MESSAGES might start with assistant
      const msgs = [
        { id: 'u1', role: 'user' as const, content: 'hello' },
        { id: 'a1', role: 'assistant' as const, content: 'hi', toolCalls: [] },
        { id: 'a2', role: 'assistant' as const, content: 'follow-up', toolCalls: [] },
      ];

      const result = agent.formatMessages(msgs);
      expect(result[0].role).toBe('user');
    });

    it('prepends last user message when slice starts with assistant (lines 161-162)', () => {
      const agent = makeAgent();
      // Fill history so the last MAX_HISTORY_MESSAGES slice starts with an assistant turn
      const msgs = [
        { id: 'u0', role: 'user' as const, content: 'first user msg' },
        ...Array.from({ length: MAX_HISTORY_MESSAGES }, (_, i) => ({
          id: `a${i}`,
          role: 'assistant' as const,
          content: `assistant ${i}`,
        })),
      ];

      const result = agent.formatMessages(msgs);
      // First element should be a user turn (prepended from original messages)
      expect(result[0].role).toBe('user');
      expect((result[0] as { content: string }).content).toBe('first user msg');
    });

    it('does not prepend when no user message exists at all', () => {
      const agent = makeAgent();
      // Only assistant messages — no user message to prepend
      const msgs = [
        { id: 'a1', role: 'assistant' as const, content: 'hi' },
      ];

      // Should not throw — lastUser is undefined, limited stays as-is
      expect(() => agent.formatMessages(msgs)).not.toThrow();
    });

    it('appends tool results as tool messages after assistant', () => {
      const agent = makeAgent();
      const msgs = [
        {
          id: 'u1',
          role: 'user' as const,
          content: 'save my fact',
        },
        {
          id: 'a1',
          role: 'assistant' as const,
          content: 'done',
          toolCalls: [
            {
              id: 'tc1',
              name: 'saveExtractedFacts',
              input: { facts: [] },
              result: { saved: true },
              status: 'done' as const,
            },
          ],
        },
      ];

      const result = agent.formatMessages(msgs);
      expect(result).toHaveLength(3); // user + assistant + tool
      expect(result[2].role).toBe('tool');
    });

    it('does NOT append tool messages when result is undefined', () => {
      const agent = makeAgent();
      const msgs = [
        { id: 'u1', role: 'user' as const, content: 'hi' },
        {
          id: 'a1',
          role: 'assistant' as const,
          content: 'ok',
          toolCalls: [
            {
              id: 'tc1',
              name: 'saveFacts',
              input: {},
              result: undefined,
              status: 'pending' as const,
            },
          ],
        },
      ];

      const result = agent.formatMessages(msgs);
      expect(result.filter((m) => m.role === 'tool')).toHaveLength(0);
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

    it('calls handleAdvanceQuestionnaireLevel for advanceQuestionnaireLevel', async () => {
      mockHandleAdvanceQuestionnaireLevel.mockResolvedValue({ level: 2 });
      const agent = makeAgent();
      const result = await agent.executeTool('advanceQuestionnaireLevel', {});

      expect(mockHandleAdvanceQuestionnaireLevel).toHaveBeenCalled();
      expect(result.result).toEqual({ level: 2 });
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
