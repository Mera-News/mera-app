// ArticleFeedbackAgent.test.ts — unit tests for lib/llm/agents/ArticleFeedbackAgent.ts

const mockGetFacts = jest.fn();

jest.mock('../../database/services/fact-service', () => ({
  getFacts: (...args: unknown[]) => mockGetFacts(...args),
}));

const mockGetSuggestionFeedbackContext = jest.fn();

jest.mock('../../database/services/article-suggestion-service', () => ({
  getSuggestionFeedbackContext: (...args: unknown[]) => mockGetSuggestionFeedbackContext(...args),
}));

const mockMarkFeedbackProcessedFor = jest.fn((..._args: unknown[]) => Promise.resolve());

jest.mock('../../database/services/article-feedback-service', () => ({
  markFeedbackProcessedFor: (...args: unknown[]) => mockMarkFeedbackProcessedFor(...args),
}));

// not-interested P4a: the agent now reads the user's ACTIVE filters (to render
// `## YOUR FILTERS` and to validate a retire_suppression id). Mock scaffold
// only — lib/database/services/suppression-service constructs a live
// SQLiteAdapter at import time. No pre-existing assertion changed.
const mockGetActiveSuppressions = jest.fn();

jest.mock('../../database/services/suppression-service', () => ({
  getActive: (...args: unknown[]) => mockGetActiveSuppressions(...args),
}));

const mockExecuteProposalActions = jest.fn();

jest.mock('../../chat-tools/proposal-handlers', () => ({
  executeProposalActions: (...args: unknown[]) => mockExecuteProposalActions(...args),
}));

const mockIsSubjectTracked = jest.fn();

jest.mock('../../tracking/track-actions', () => ({
  isSubjectTracked: (...args: unknown[]) => mockIsSubjectTracked(...args),
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

const mockHandleWebSearch = jest.fn();

jest.mock('../../chat-tools/web-search-handler', () => ({
  handleWebSearch: (...args: unknown[]) => mockHandleWebSearch(...args),
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
    mockIsSubjectTracked.mockResolvedValue(false);
    // not-interested P4a default — no active filters, so every pre-existing
    // context/proposal expectation sees exactly what it saw before.
    mockGetActiveSuppressions.mockResolvedValue([]);
    mockHandleWebSearch.mockResolvedValue({ searched: true, query: 'q', results: [] });
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

    // pivot P6 (F4): the cache key used to omit the web-search toggle
    // entirely, so a prompt built while the toggle was off would keep
    // serving stale "you don't have the full article" text even after the
    // user flipped it on — getToolDefinitions() would then declare the tool
    // while the (cached) prompt never told the model it could use it. That is
    // the exact "toggle on, still refuses" bug the user reported.
    it('rebuilds (does not serve a stale cache) when the toggle flips, and teaches search once on', async () => {
      mockMeraProtocolGetState.mockReturnValue({ processingMode: 'CLOUD', webSearchInChat: false });
      const agent = makeAgent();
      const off = await agent.buildSystemPrompt(false);
      expect(off).not.toContain('WEB SEARCH');

      mockMeraProtocolGetState.mockReturnValue({ processingMode: 'CLOUD', webSearchInChat: true });
      const on = await agent.buildSystemPrompt(false);
      expect(on).not.toBe(off);
      expect(on).toContain('WEB SEARCH');
    });

    it('does not teach search prose when the toggle is on but mode is LOCAL', async () => {
      mockMeraProtocolGetState.mockReturnValue({ processingMode: 'ON_DEVICE', webSearchInChat: true });
      const prompt = await makeAgent().buildSystemPrompt(false);
      expect(prompt).not.toContain('WEB SEARCH');
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
    it('exposes the proposal + follow + claim-picker tools', () => {
      const names = makeAgent().getToolDefinitions().map((t) => t.function.name);
      expect(names).toEqual([
        'proposeChanges',
        'proposeTrack',
        'applyProposal',
        'cancelProposal',
        // pivot P8c: the Quick fact check chip and the article tick both send
        // into THIS thread, so the claim picker lives on this agent.
        'proposeFactCheck',
      ]);
    });

    // CLOUD-only, and for a reason that is not webSearch's: its prompt section
    // is ~1,200 measured tokens against a ~3,072-token local input budget, and
    // the check it proposes needs the cloud regardless.
    it('never declares proposeFactCheck in LOCAL mode', () => {
      mockMeraProtocolGetState.mockReturnValue({ processingMode: 'ON_DEVICE', webSearchInChat: false });
      const names = makeAgent().getToolDefinitions().map((t) => t.function.name);
      expect(names).not.toContain('proposeFactCheck');
    });

    // pivot P6 (F4): this surface never declared webSearch at all, so the
    // "Web search in chat" toggle was inert here no matter its value. These
    // pin BOTH directions of the fix.
    it('omits webSearch when the toggle is off (default beforeEach state)', () => {
      const names = makeAgent().getToolDefinitions().map((t) => t.function.name);
      expect(names).not.toContain('webSearch');
    });

    it('declares webSearch in CLOUD mode when the toggle is on', () => {
      mockMeraProtocolGetState.mockReturnValue({ processingMode: 'CLOUD', webSearchInChat: true });
      const names = makeAgent().getToolDefinitions().map((t) => t.function.name);
      expect(names).toContain('webSearch');
    });

    it('never declares webSearch in LOCAL mode, even with the toggle on', () => {
      mockMeraProtocolGetState.mockReturnValue({ processingMode: 'ON_DEVICE', webSearchInChat: true });
      const names = makeAgent().getToolDefinitions().map((t) => t.function.name);
      expect(names).not.toContain('webSearch');
    });
  });

  describe('executeTool — proposeTrack (follow this story)', () => {
    const trackSubject = {
      origin: 'suggestion' as const,
      surface: 'detail',
      articleId: 'art-1',
      title: 'Protest escalates in Sonbhadra',
      stableClusterId: 'sc-1',
      publicationName: 'The Hindu',
    };

    function makeTrackAgent() {
      return new ArticleFeedbackAgent('user-1', { articleId: 'art-1' }, trackSubject);
    }

    it('stages a track_story proposal carrying the embedded subject', async () => {
      mockIsSubjectTracked.mockResolvedValueOnce(false);
      const result = await makeTrackAgent().executeTool('proposeTrack', {
        options: [
          { label: 'Sonbhadra exam protest', search: 'sonbhadra student exam result protest' },
        ],
      });

      expect(result.sideEffects?.proposal?.actions).toEqual([
        {
          type: 'track_story',
          label: 'Sonbhadra exam protest',
          searchText: 'sonbhadra student exam result protest',
          subject: trackSubject,
        },
      ]);
      // proposalId + subject echoed so deriveThreadItems can rebuild the card.
      expect(result.result.proposalId).toBe(result.sideEffects?.proposal?.id);
      expect(result.result.subject).toEqual(trackSubject);
    });

    it('declines (no proposal) when the story is already followed', async () => {
      mockIsSubjectTracked.mockResolvedValueOnce(true);
      const result = await makeTrackAgent().executeTool('proposeTrack', {
        track: 'Updates on the protest',
      });

      expect(result.result.alreadyTracked).toBe(true);
      expect(result.sideEffects).toBeUndefined();
    });

    it('errors when there is no article subject to follow', async () => {
      // suggestionId-only agent with no trackSubject and no articleId → no subject.
      const result = await makeAgent().executeTool('proposeTrack', { track: 'x' });
      expect(result.result.error).toContain('no article to follow');
      expect(mockIsSubjectTracked).not.toHaveBeenCalled();
    });

    it('rejects an empty set of options', async () => {
      mockIsSubjectTracked.mockResolvedValueOnce(false);
      const result = await makeTrackAgent().executeTool('proposeTrack', {
        options: [{ label: '   ', search: '' }],
      });
      expect(result.result.error).toContain('options is required');
      expect(result.sideEffects).toBeUndefined();
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

    it('stamps the feed-verdict feedback processed when a handoff proposal applies', async () => {
      mockFloatingChatGetState.mockReturnValue({
        proposal: { id: 'p1', explanation: '', expectedEffects: '', actions: [{ type: 'add_fact', statement: 'X' }] },
        context: { kind: 'article-suggestion', articleId: 'art-1', verdict: 'like' },
      });
      await makeAgent().executeTool('applyProposal', {});
      expect(mockMarkFeedbackProcessedFor).toHaveBeenCalledWith('art-1', 'like');
    });

    it('does NOT stamp feedback processed when the context carries no verdict', async () => {
      mockFloatingChatGetState.mockReturnValue({
        proposal: { id: 'p1', explanation: '', expectedEffects: '', actions: [{ type: 'add_fact', statement: 'X' }] },
        context: { kind: 'article-suggestion', articleId: 'art-1' },
      });
      await makeAgent().executeTool('applyProposal', {});
      expect(mockMarkFeedbackProcessedFor).not.toHaveBeenCalled();
    });

    // --- G1: a SINGLE-SELECT card may only be resolved by a tap ---
    //
    // Regression: applyProposal used to hand the executor `proposal.actions`
    // wholesale, so a typed "yes" against a 3-pill proposeTrack card minted
    // three topics AND three followed stories. Only ProposalCard.handleConfirm
    // knows WHICH pill the user picked, so the agent must refuse outright.
    const trackAction = (label: string) => ({
      type: 'track_story' as const,
      label,
      searchText: label.toLowerCase(),
      subject: { id: 'a1', title: 'T' },
    });

    it('REFUSES to apply a chooseOne proposal (3 track pills) from chat', async () => {
      mockFloatingChatGetState.mockReturnValue({
        proposal: {
          id: 'track-1',
          explanation: '',
          expectedEffects: '',
          chooseOne: true,
          actions: [
            trackAction('Attacks on Ukraine infrastructure'),
            trackAction('Russia–Ukraine war'),
            trackAction('European security crisis'),
          ],
        },
      });
      const result = await makeAgent().executeTool('applyProposal', {});
      // Nothing is minted — not one pill, not three.
      expect(mockExecuteProposalActions).not.toHaveBeenCalled();
      expect(result.result).toMatchObject({ applied: 0, awaitingUserConfirmation: true });
      // …and the user is NOT stranded: the card stays pending and tappable, and
      // the model is handed a message it can relay.
      expect(result.sideEffects?.proposalResolved).toBeUndefined();
      expect(typeof result.result.message).toBe('string');
      expect((result.result.message as string).length).toBeGreaterThan(0);
    });

    it('REFUSES a chooseOne proposeChanges card (mutually-exclusive alternatives)', async () => {
      mockFloatingChatGetState.mockReturnValue({
        proposal: {
          id: 'p-choose',
          explanation: 'Less of this?',
          expectedEffects: 'Pick how far to go.',
          chooseOne: true,
          actions: [
            { type: 'set_topic_weight', topicText: 'cricket', delta: -0.3 },
            { type: 'retire_topic', topicText: 'cricket' },
          ],
        },
      });
      const result = await makeAgent().executeTool('applyProposal', {});
      expect(mockExecuteProposalActions).not.toHaveBeenCalled();
      expect(result.result).toMatchObject({ applied: 0, awaitingUserConfirmation: true });
      expect(result.sideEffects?.proposalResolved).toBeUndefined();
    });

    it('still applies a chooseOne proposal that degenerated to ONE action', async () => {
      // `chooseOne` with a single action is not a choice — the card renders as a
      // plain confirm (ProposalCard: chooseOne && actions.length > 1), so the
      // agent must keep applying it or a confirmable proposal becomes unreachable.
      mockFloatingChatGetState.mockReturnValue({
        proposal: {
          id: 'track-solo',
          explanation: '',
          expectedEffects: '',
          chooseOne: true,
          actions: [trackAction('Russia–Ukraine war')],
        },
      });
      const result = await makeAgent().executeTool('applyProposal', {});
      expect(mockExecuteProposalActions).toHaveBeenCalledWith([trackAction('Russia–Ukraine war')]);
      expect(result.sideEffects?.proposalResolved).toBe('applied');
    });

    it('refuses a run_calibration-only proposal without destroying the card', async () => {
      // The executor silently drops run_calibration unless confirmedByUser, so
      // applying one from chat used to report applied:0 AND resolve the card —
      // the recalibration became unreachable. (Sibling guard: PersonaUpdateAgent.)
      mockFloatingChatGetState.mockReturnValue({
        proposal: {
          id: 'cal-1',
          explanation: '',
          expectedEffects: '',
          actions: [{ type: 'run_calibration' }],
        },
      });
      const result = await makeAgent().executeTool('applyProposal', {});
      expect(mockExecuteProposalActions).not.toHaveBeenCalled();
      expect(result.result).toMatchObject({ applied: 0, awaitingUserConfirmation: true });
      expect(result.sideEffects?.proposalResolved).toBeUndefined();
    });

    it('applies the other actions of a mixed run_calibration proposal, card intact', async () => {
      mockFloatingChatGetState.mockReturnValue({
        proposal: {
          id: 'cal-mix',
          explanation: '',
          expectedEffects: '',
          actions: [{ type: 'run_calibration' }, { type: 'add_fact', statement: 'Likes AI' }],
        },
      });
      const result = await makeAgent().executeTool('applyProposal', {});
      expect(mockExecuteProposalActions).toHaveBeenCalledWith([
        { type: 'add_fact', statement: 'Likes AI' },
      ]);
      expect(result.result).toMatchObject({ awaitingUserConfirmation: true });
      expect(result.sideEffects?.proposalResolved).toBeUndefined();
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

  // pivot P6 (F4): wires the tool call through to the shared handler, the
  // same one PersonaUpdateAgent uses — including for an UNDECLARED replayed
  // call (toggle now off, conversation persisted from when it was on): the
  // handler re-checks the toggle itself, so this must reach it rather than
  // fall into "Unknown tool".
  describe('executeTool — webSearch', () => {
    it('delegates to handleWebSearch and returns its result verbatim', async () => {
      mockHandleWebSearch.mockResolvedValue({
        searched: true,
        query: 'eu ai act enforcement',
        results: [{ title: 'T', url: 'https://e.com', snippet: 'S' }],
      });
      const result = await makeAgent().executeTool('webSearch', { query: 'eu ai act enforcement' });
      expect(mockHandleWebSearch).toHaveBeenCalledWith({ query: 'eu ai act enforcement' });
      expect(result.result).toEqual({
        searched: true,
        query: 'eu ai act enforcement',
        results: [{ title: 'T', url: 'https://e.com', snippet: 'S' }],
      });
    });

    it('still reaches the handler (which itself refuses) for an undeclared replayed call', async () => {
      // No declaration gating here — that's getToolDefinitions's job. This
      // proves the EXECUTION path does not itself gate on the toggle; the
      // handler is the one source of truth for refusing.
      mockHandleWebSearch.mockResolvedValue({ error: 'switched off', searched: false });
      const result = await makeAgent().executeTool('webSearch', { query: 'x' });
      expect(mockHandleWebSearch).toHaveBeenCalled();
      expect(result.result).toEqual({ error: 'switched off', searched: false });
    });
  });
});
