// ArticleFeedbackAgent.test.ts — unit tests for lib/llm/agents/ArticleFeedbackAgent.ts

const mockGetFacts = jest.fn();

jest.mock('../../database/services/fact-service', () => ({
  getFacts: (...args: unknown[]) => mockGetFacts(...args),
}));

const mockGetSuggestionFeedbackContext = jest.fn();

jest.mock('../../database/services/article-suggestion-service', () => ({
  getSuggestionFeedbackContext: (...args: unknown[]) => mockGetSuggestionFeedbackContext(...args),
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
}));

jest.mock('../../generated/graphql-types', () => ({
  ProcessingMode: { OnDevice: 'ON_DEVICE', Cloud: 'CLOUD' },
}));

jest.mock('../../translation-service', () => ({
  SUPPORTED_LANGUAGES: [
    { code: 'en', name: 'English' },
    { code: 'fr', name: 'French' },
  ],
}));

jest.mock('../../logger', () => ({
  __esModule: true,
  default: { warn: jest.fn(), error: jest.fn(), debug: jest.fn(), info: jest.fn() },
}));

import { ArticleFeedbackAgent } from '../agents/ArticleFeedbackAgent';

const SUGGESTION_ID = 'sugg-1';

function makeAgent(target: { articleId?: string; suggestionId?: string } = { suggestionId: SUGGESTION_ID }) {
  return new ArticleFeedbackAgent('user-1', target);
}

function completeSuggestion(overrides: Record<string, unknown> = {}) {
  return {
    _id: SUGGESTION_ID,
    title_en: 'EU passes AI Act',
    title_original: null,
    description_en: 'The European Union has approved sweeping AI regulation affecting all member states.',
    publication_name: 'Euronews',
    status: 'complete',
    relevance: 0.62,
    reason: 'Relates to your AI engineering work.',
    ...overrides,
  };
}

describe('ArticleFeedbackAgent', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockAppLanguageGetState.mockReturnValue({ appLanguage: 'en' });
    mockMeraProtocolGetState.mockReturnValue({ processingMode: 'CLOUD' });
    mockGetFacts.mockResolvedValue([]);
    mockFloatingChatGetState.mockReturnValue({
      context: { kind: 'article-suggestion', suggestionId: SUGGESTION_ID },
      proposal: null,
      setProposal: jest.fn(),
      resolveProposal: jest.fn(),
    });
    mockExecuteProposalActions.mockResolvedValue({ applied: 1, errors: [], summaries: [], changeLogIds: [] });
  });

  describe('constructor', () => {
    it('derives id from suggestionId', () => {
      expect(makeAgent({ suggestionId: 'abc' }).id).toBe('article-feedback-abc');
    });
    it('falls back to articleId when no suggestionId', () => {
      expect(makeAgent({ articleId: 'art-9' }).id).toBe('article-feedback-art-9');
    });
  });

  describe('buildSystemPrompt', () => {
    it('includes the XML tool format block only when needsToolFormat', async () => {
      const agent = makeAgent();
      const withFormat = await agent.buildSystemPrompt(true);
      // reset cache by changing param
      const withoutFormat = await agent.buildSystemPrompt(false);

      expect(withFormat).toContain('<tool_call>');
      expect(withFormat).toContain('proposeChanges');
      expect(withoutFormat).not.toContain('<tool_call>');
    });

    it('states the capability boundaries and feature-request escape hatch', async () => {
      const prompt = await makeAgent().buildSystemPrompt(false);
      expect(prompt).toContain('CANNOT');
      expect(prompt).toContain('submit_feature_request');
    });

    it('honours the app language', async () => {
      mockAppLanguageGetState.mockReturnValue({ appLanguage: 'fr' });
      const prompt = await makeAgent().buildSystemPrompt(false);
      expect(prompt).toContain('French');
    });

    it('memoizes across identical calls', async () => {
      const agent = makeAgent();
      const a = await agent.buildSystemPrompt(false);
      const b = await agent.buildSystemPrompt(false);
      expect(a).toBe(b);
    });
  });

  describe('buildContext', () => {
    it('renders ARTICLE, relevance status, topics, and producing facts', async () => {
      mockGetSuggestionFeedbackContext.mockResolvedValue({
        suggestion: completeSuggestion(),
        matchedTopicTexts: ['EU AI regulation', 'AI policy'],
        linkedFacts: [{ id: 'f1', statement: 'Senior ML engineer at DeepMind' }],
      });
      mockGetFacts.mockResolvedValue([
        { id: 'f1', statement: 'Senior ML engineer at DeepMind', metadata: { topics: ['AI', 'ML', 'startups', 'extra'] } },
      ]);

      const ctx = await makeAgent().buildContext();
      expect(ctx).toContain('## ARTICLE');
      expect(ctx).toContain('EU passes AI Act');
      expect(ctx).toContain('Relevance score: 6.2/10');
      expect(ctx).toContain('EU AI regulation');
      expect(ctx).toContain('[f1] Senior ML engineer at DeepMind');
      expect(ctx).toContain('## ALL YOUR FACTS');
      // topics preview capped at 3
      expect(ctx).toContain('(topics: AI, ML, startups)');
    });

    it('falls back to the store title and the "not a suggestion" status when no row exists', async () => {
      mockGetSuggestionFeedbackContext.mockResolvedValue(null);
      mockFloatingChatGetState.mockReturnValue({
        context: { kind: 'article-suggestion', articleId: 'art-1', articleTitle: 'A cluster article' },
        proposal: null,
      });

      const ctx = await makeAgent({ articleId: 'art-1' }).buildContext();
      expect(ctx).toContain('A cluster article');
      expect(ctx).toContain('This article was NOT one of your personalized suggestions.');
    });

    it('marks an unscored suggestion', async () => {
      mockGetSuggestionFeedbackContext.mockResolvedValue({
        suggestion: completeSuggestion({ status: 'unscored', relevance: 0, reason: '' }),
        matchedTopicTexts: [],
        linkedFacts: [],
      });
      const ctx = await makeAgent().buildContext();
      expect(ctx).toContain('scoring has not finished');
    });

    it('injects the PENDING PROPOSAL block when a proposal is staged', async () => {
      mockGetSuggestionFeedbackContext.mockResolvedValue({
        suggestion: completeSuggestion(),
        matchedTopicTexts: [],
        linkedFacts: [],
      });
      mockFloatingChatGetState.mockReturnValue({
        context: { kind: 'article-suggestion', suggestionId: SUGGESTION_ID },
        proposal: {
          id: 'p1',
          explanation: 'You wanted less AI news.',
          expectedEffects: 'Fewer AI stories.',
          actions: [{ type: 'remove_topics', fact_id: 'f1', topics: ['AI'] }],
        },
      });
      const ctx = await makeAgent().buildContext();
      expect(ctx).toContain('## PENDING PROPOSAL');
      expect(ctx).toContain('You wanted less AI news.');
      expect(ctx).toContain('applyProposal');
    });

    it('drops the ALL-FACTS block when the context exceeds the token budget', async () => {
      mockGetSuggestionFeedbackContext.mockResolvedValue({
        suggestion: completeSuggestion(),
        matchedTopicTexts: [],
        linkedFacts: [],
      });
      // 12 facts with long statements + topics push the assembled context past
      // ~1800 tokens (~7200 chars).
      const bigStatement = 'x'.repeat(115);
      mockGetFacts.mockResolvedValue(
        Array.from({ length: 12 }, (_, i) => ({
          id: `f${i}`,
          statement: bigStatement,
          metadata: { topics: ['a'.repeat(300), 'b'.repeat(300), 'c'.repeat(300)] },
        })),
      );
      const ctx = await makeAgent().buildContext();
      expect(ctx).not.toContain('## ALL YOUR FACTS');
      // essential blocks survive
      expect(ctx).toContain('## ARTICLE');
    });
  });

  describe('getToolDefinitions', () => {
    it('exposes the three proposal tools', () => {
      const names = makeAgent().getToolDefinitions().map((t) => t.function.name);
      expect(names).toEqual(['proposeChanges', 'applyProposal', 'cancelProposal']);
    });
  });

  describe('executeTool — proposeChanges', () => {
    it('stages a valid proposal and returns it as a side effect', async () => {
      mockGetFacts.mockResolvedValue([{ id: 'f1', statement: 'AI engineer' }]);
      const result = await makeAgent().executeTool('proposeChanges', {
        explanation: 'You wanted less AI news.',
        expected_effects: 'Fewer AI stories.',
        actions: [{ type: 'remove_topics', fact_id: 'f1', topics: ['AI'] }],
      });
      expect(result.result).toEqual({
        staged: true,
        actionCount: 1,
        proposalId: result.sideEffects?.proposal?.id,
      });
      expect(result.sideEffects?.proposal?.actions).toHaveLength(1);
      expect(result.sideEffects?.proposal?.id).toMatch(/^proposal-/);
    });

    it('echoes the staged proposal id in the result (deriveThreadItems keys the card on it)', async () => {
      mockGetFacts.mockResolvedValue([]);
      const result = await makeAgent().executeTool('proposeChanges', {
        explanation: 'x',
        expected_effects: 'y',
        actions: [{ type: 'add_fact', statement: 'Likes AI' }],
      });
      expect(result.result.proposalId).toBeDefined();
      expect(result.result.proposalId).toBe(result.sideEffects?.proposal?.id);
    });

    it('rejects an action referencing an unknown fact_id', async () => {
      mockGetFacts.mockResolvedValue([{ id: 'f1', statement: 'AI engineer' }]);
      const result = await makeAgent().executeTool('proposeChanges', {
        explanation: 'x',
        expected_effects: 'y',
        actions: [{ type: 'delete_fact', fact_id: 'ghost' }],
      });
      expect(result.result.error).toContain('ghost');
      expect(result.sideEffects).toBeUndefined();
    });

    it('rejects a missing explanation', async () => {
      const result = await makeAgent().executeTool('proposeChanges', {
        expected_effects: 'y',
        actions: [{ type: 'add_fact', statement: 'Likes AI' }],
      });
      expect(result.result.error).toContain('explanation');
    });

    it('validates and stages a submit_feature_request action (no fact_id needed)', async () => {
      mockGetFacts.mockResolvedValue([]);
      const result = await makeAgent().executeTool('proposeChanges', {
        explanation: "I'll send this suggestion to the Mera team.",
        expected_effects: "The team will consider it — this won't change your feed today.",
        actions: [
          { type: 'submit_feature_request', title: 'Mute a publication', summary: 'Allow users to mute a publication so its articles stop appearing.' },
        ],
      });
      expect(result.result).toEqual({
        staged: true,
        actionCount: 1,
        proposalId: result.sideEffects?.proposal?.id,
      });
      expect(result.sideEffects?.proposal?.actions[0]).toEqual({
        type: 'submit_feature_request',
        title: 'Mute a publication',
        summary: 'Allow users to mute a publication so its articles stop appearing.',
      });
    });

    it('rejects a submit_feature_request with an over-long title', async () => {
      const result = await makeAgent().executeTool('proposeChanges', {
        explanation: 'x',
        expected_effects: 'y',
        actions: [{ type: 'submit_feature_request', title: 'z'.repeat(81), summary: 'ok' }],
      });
      expect(result.result.error).toContain('title');
    });
  });

  describe('executeTool — applyProposal / cancelProposal', () => {
    it('applies the pending proposal', async () => {
      mockFloatingChatGetState.mockReturnValue({
        proposal: { id: 'p1', explanation: '', expectedEffects: '', actions: [{ type: 'add_fact', statement: 'Likes AI' }] },
      });
      const result = await makeAgent().executeTool('applyProposal', {});
      expect(mockExecuteProposalActions).toHaveBeenCalled();
      expect(result.result).toEqual({ applied: 1, errors: [], summaries: [], changeLogIds: [] });
      expect(result.sideEffects?.proposalResolved).toBe('applied');
    });

    it('errors when there is no pending proposal to apply', async () => {
      mockFloatingChatGetState.mockReturnValue({ proposal: null });
      const result = await makeAgent().executeTool('applyProposal', {});
      expect(result.result).toEqual({ error: 'no pending proposal' });
      expect(mockExecuteProposalActions).not.toHaveBeenCalled();
    });

    it('cancels a proposal', async () => {
      const result = await makeAgent().executeTool('cancelProposal', {});
      expect(result.result).toEqual({ cancelled: true });
      expect(result.sideEffects?.proposalResolved).toBe('cancelled');
    });

    it('returns an error for an unknown tool', async () => {
      const result = await makeAgent().executeTool('bogus', {});
      expect(result.result.error).toContain('Unknown tool');
    });
  });
});
