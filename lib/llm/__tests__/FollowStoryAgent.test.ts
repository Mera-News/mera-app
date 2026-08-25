// FollowStoryAgent tests — the article-less "follow a story" chat agent behind
// the Followed-stories track FAB.
//
// What is asserted here is the propose-then-confirm contract:
//   - proposeTrack stages the SAME `track_story` scope pills the article surface
//     stages (single-select when ≥2 survive), against an article-less subject;
//   - nothing is applied from chat — the pills are chosen by tapping the card,
//     so neither a decline nor a model-invented applyProposal may execute
//     anything.

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

// lib/translation-service pulls in the expo-translate-text native module at
// import time; the agent only needs the language table off it.
jest.mock('../../translation-service', () => ({
  SUPPORTED_LANGUAGES: [
    { code: 'en', name: 'English' },
    { code: 'fr', name: 'French' },
  ],
}));

jest.mock('../../logger', () => ({
  __esModule: true,
  default: { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn(), captureMessage: jest.fn() },
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

const mockHandleSearchNews = jest.fn();

jest.mock('../../chat-tools/news-search-handler', () => ({
  handleSearchNews: (...args: unknown[]) => mockHandleSearchNews(...args),
}));

const mockHandleWebSearch = jest.fn();

jest.mock('../../chat-tools/web-search-handler', () => ({
  handleWebSearch: (...args: unknown[]) => mockHandleWebSearch(...args),
}));

import { FollowStoryAgent } from '../agents/FollowStoryAgent';
import { FOLLOW_STORY_SURFACE } from '../../news-harness/follow-story';
import type { ProposalAction, StagedProposal } from '../../news-harness/core/types';

const makeAgent = () => new FollowStoryAgent('user-1');

beforeEach(() => {
  jest.clearAllMocks();
  mockFloatingChatGetState.mockReturnValue({ proposal: null, context: { kind: 'follow-story' } });
  mockAppLanguageGetState.mockReturnValue({ appLanguage: 'en' });
  mockMeraProtocolGetState.mockReturnValue({ processingMode: 'CLOUD', webSearchInChat: true });
  mockHandleSearchNews.mockResolvedValue({ articles: [] });
  mockHandleWebSearch.mockResolvedValue({ searched: true, searches: [] });
  mockExecuteProposalActions.mockResolvedValue({
    applied: 1,
    errors: [],
    summaries: [],
    changeLogIds: [],
  });
});

describe('FollowStoryAgent — identity and prompt', () => {
  it('scopes its id per user', () => {
    expect(makeAgent().id).toBe('follow-story-user-1');
  });

  it('builds a prompt that names the article-less follow flow and proposeTrack', async () => {
    const prompt = await makeAgent().buildSystemPrompt(false);

    expect(prompt).toContain('proposeTrack');
    expect(prompt).toContain('NO article');
  });

  it('adds the XML tool-call block only for the local path', async () => {
    expect(await makeAgent().buildSystemPrompt(true)).toContain('<tool_call>');
    expect(await makeAgent().buildSystemPrompt(false)).not.toContain('<tool_call>');
  });

  // The prompt is static per (toolFormat, language) — rebuilding it every turn
  // would break the KV cache the whole session rides on.
  it('reuses the cached prompt for an identical second call', async () => {
    const agent = makeAgent();
    const first = await agent.buildSystemPrompt(false);

    expect(await agent.buildSystemPrompt(false)).toBe(first);
    expect(mockAppLanguageGetState).toHaveBeenCalledTimes(2); // language re-read, prompt reused
  });

  it('rebuilds when the app language changes mid-session', async () => {
    const agent = makeAgent();
    const english = await agent.buildSystemPrompt(false);

    mockAppLanguageGetState.mockReturnValue({ appLanguage: 'fr' });
    const french = await agent.buildSystemPrompt(false);

    expect(french).not.toBe(english);
    expect(french).toContain('**French**');
  });

  it('falls back to English for a language outside the supported table', async () => {
    mockAppLanguageGetState.mockReturnValue({ appLanguage: 'xx' });

    expect(await makeAgent().buildSystemPrompt(false)).toContain('**English**');
  });

  it('exposes the proposal and retrieval tools, and deliberately NOT applyProposal', () => {
    const names = makeAgent()
      .getToolDefinitions()
      .map((t) => t.function.name);

    expect(names).toEqual(['proposeTrack', 'cancelProposal', 'searchNews', 'webSearch']);
    expect(names).not.toContain('applyProposal');
  });

  it('drops webSearch when the user has the toggle off', () => {
    mockMeraProtocolGetState.mockReturnValue({ processingMode: 'CLOUD', webSearchInChat: false });

    const names = makeAgent()
      .getToolDefinitions()
      .map((t) => t.function.name);

    expect(names).toEqual(['proposeTrack', 'cancelProposal', 'searchNews']);
  });

  it('offers no retrieval at all on the on-device path', () => {
    mockMeraProtocolGetState.mockReturnValue({
      processingMode: 'ON_DEVICE',
      webSearchInChat: true,
    });

    const names = makeAgent()
      .getToolDefinitions()
      .map((t) => t.function.name);

    expect(names).toEqual(['proposeTrack', 'cancelProposal']);
  });

  // THE REGRESSION GUARD for "toggle on, still refuses": the prompt is cached,
  // so if the toggle is not part of the cache key the model keeps being told it
  // cannot search while the tool payload says it can.
  it('rebuilds the system prompt when the web-search toggle flips', async () => {
    const agent = makeAgent();
    mockMeraProtocolGetState.mockReturnValue({ processingMode: 'CLOUD', webSearchInChat: false });
    const before = await agent.buildSystemPrompt(false);

    mockMeraProtocolGetState.mockReturnValue({ processingMode: 'CLOUD', webSearchInChat: true });
    const after = await agent.buildSystemPrompt(false);

    expect(after).not.toBe(before);
    expect(after).toContain('webSearch');
  });

  it('executes the retrieval tools instead of refusing them', async () => {
    const agent = makeAgent();
    mockHandleSearchNews.mockResolvedValue({ articles: [{ title: 'H' }] });

    await expect(agent.executeTool('searchNews', { query: 'Sporting CP' })).resolves.toEqual({
      result: { articles: [{ title: 'H' }] },
    });
    expect(mockHandleSearchNews).toHaveBeenCalledWith({ query: 'Sporting CP' });

    await agent.executeTool('webSearch', { queries: ['Sporting CP news'] });
    expect(mockHandleWebSearch).toHaveBeenCalledWith({ queries: ['Sporting CP news'] });
  });

  // A forced pass with tool_choice:'required' would stage a follow nobody asked
  // for on a turn like "thanks".
  it('declares no forced-extraction tools', () => {
    expect(makeAgent().getForcedExtractionTools()).toEqual([]);
  });
});

describe('FollowStoryAgent — buildContext', () => {
  it('anchors the model to today and stays article-free', async () => {
    const context = await makeAgent().buildContext();

    expect(context).toMatch(/Today: \d{4}-\d{2}-\d{2}/);
    expect(context).not.toContain('## ARTICLE');
  });

  it('re-injects the pending scope card so a decline resolves on the local path', async () => {
    const proposal: StagedProposal = {
      id: 'p-1',
      explanation: '',
      expectedEffects: '',
      chooseOne: true,
      actions: [
        {
          type: 'track_story',
          label: 'Russia–Ukraine war',
          searchText: 'russia ukraine war',
          subject: { origin: 'article', surface: FOLLOW_STORY_SURFACE, articleId: '', title: '' },
        },
      ],
    };
    mockFloatingChatGetState.mockReturnValue({ proposal, context: { kind: 'follow-story' } });

    const context = await makeAgent().buildContext();

    expect(context).toContain('PENDING SCOPE CARD');
    expect(context).toContain('Russia–Ukraine war');
    expect(context).toContain('cancelProposal');
  });
});

describe('FollowStoryAgent — proposeTrack', () => {
  it('stages one track_story action per scope pill, single-select', async () => {
    const result = await makeAgent().executeTool('proposeTrack', {
      options: [
        { label: 'Hungarian GP updates', search: 'hungarian grand prix formula 1' },
        { label: 'Formula 1 season', search: 'formula 1 racing season' },
      ],
    });

    const proposal = result.sideEffects?.proposal as StagedProposal;
    expect(proposal.actions).toHaveLength(2);
    expect(proposal.chooseOne).toBe(true);
    expect(proposal.actions.every((a: ProposalAction) => a.type === 'track_story')).toBe(true);
    expect(proposal.actions[0]).toMatchObject({
      type: 'track_story',
      label: 'Hungarian GP updates',
      searchText: 'hungarian grand prix formula 1',
    });
  });

  // The article surface embeds the tapped article; there is none here, and every
  // consumer already treats a blank articleId as "no origin article".
  it('embeds the article-less origin subject in every action', async () => {
    const result = await makeAgent().executeTool('proposeTrack', {
      options: [{ label: 'Ukraine war', search: 'russia ukraine war' }],
    });

    const proposal = result.sideEffects?.proposal as StagedProposal;
    const action = proposal.actions[0] as Extract<ProposalAction, { type: 'track_story' }>;
    expect(action.subject).toMatchObject({
      articleId: '',
      title: '',
      surface: FOLLOW_STORY_SURFACE,
      stableClusterId: null,
    });
  });

  it('errors (staging nothing) when the tool is called with no arguments at all', async () => {
    const result = await makeAgent().executeTool('proposeTrack', null);

    expect(result.result).toEqual({ error: 'options is required' });
    expect(result.sideEffects?.proposal).toBeUndefined();
  });

  it('errors (staging nothing) when no usable option survives parsing', async () => {
    const result = await makeAgent().executeTool('proposeTrack', { options: [] });

    expect(result.result).toEqual({ error: 'options is required' });
    expect(result.sideEffects?.proposal).toBeUndefined();
    expect(mockExecuteProposalActions).not.toHaveBeenCalled();
  });

  it('stages nothing on its own — proposing never writes', async () => {
    await makeAgent().executeTool('proposeTrack', {
      options: [{ label: 'Ukraine war', search: 'russia ukraine war' }],
    });

    expect(mockExecuteProposalActions).not.toHaveBeenCalled();
  });
});

describe('FollowStoryAgent — declining and the apply guard', () => {
  it('cancelProposal resolves the card and creates NOTHING', async () => {
    const result = await makeAgent().executeTool('cancelProposal', {});

    expect(result.result).toEqual({ cancelled: true });
    expect(result.sideEffects?.proposalResolved).toBe('cancelled');
    expect(mockExecuteProposalActions).not.toHaveBeenCalled();
  });

  // A typed "yes" must not follow anything: only the card knows WHICH pill was
  // chosen, so an agent-side apply would mint every scope at once.
  it('refuses a model-invented applyProposal instead of executing the actions', async () => {
    const result = await makeAgent().executeTool('applyProposal', {});

    expect((result.result as { error?: string }).error).toBeTruthy();
    expect(result.sideEffects).toBeUndefined();
    expect(mockExecuteProposalActions).not.toHaveBeenCalled();
  });

  it('reports an unknown tool without executing anything', async () => {
    const result = await makeAgent().executeTool('proposeChanges', { actions: [] });

    expect((result.result as { error?: string }).error).toContain('Unknown tool');
    expect(mockExecuteProposalActions).not.toHaveBeenCalled();
  });
});
