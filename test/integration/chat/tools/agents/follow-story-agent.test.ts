// FollowStoryAgent: the article-less "follow a story" chat. The propose-then-confirm contract:
// proposeTrack stages the same `track_story` scope pills the article surface stages, and nothing is
// applied from chat. Real stores, real handlers over MSW and the gateway mock, real database: "the
// executor was not called" is read as "no topic and no followed story exists".
import { FollowStoryAgent } from '@/lib/llm/agents/FollowStoryAgent';
import { FOLLOW_STORY_SURFACE } from '@/lib/news-harness/follow-story';
import type { ProposalAction, StagedProposal } from '@/lib/news-harness/core/types';
import { gatewayCalls, mockGql, server } from '@/test/helpers';
import * as followStory from '@/lib/news-harness/follow-story';
import { setProcessingMode, setWebSearchInChat } from '@/test/integration/chat/_helpers';
import { activeTopicTexts, resetAgentWorld, setLanguage, setProposal, toolNames, trackedStoryCount } from './agents-kit';

jest.setTimeout(30_000);

const makeAgent = () => new FollowStoryAgent('user-1');

beforeEach(async () => {
  await resetAgentWorld();
  await setWebSearchInChat(true);
});
afterEach(() => server.events.removeAllListeners());

/** Nothing was followed: no minted topic, no tracked-story row. */
async function expectNothingFollowed(): Promise<void> {
  expect(await activeTopicTexts()).toEqual([]);
  expect(await trackedStoryCount()).toBe(0);
}

describe('FollowStoryAgent: identity and prompt', () => {
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

  // The cache is observed by counting calls into the REAL builder (a spy, no replacement).
  it('caches the prompt: an identical second call does not rebuild it', async () => {
    const agent = makeAgent();
    const build = jest.spyOn(followStory, 'buildFollowStorySystemPrompt');
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

  it('rebuilds when the app language changes mid-session', async () => {
    const agent = makeAgent();
    const english = await agent.buildSystemPrompt(false);

    setLanguage('fr');
    const french = await agent.buildSystemPrompt(false);

    expect(french).not.toBe(english);
    expect(french).toContain('**French**');
  });

  it('falls back to English for a language outside the supported table', async () => {
    setLanguage('xx');
    expect(await makeAgent().buildSystemPrompt(false)).toContain('**English**');
  });

  it('exposes the proposal and retrieval tools, and deliberately NOT applyProposal', () => {
    const names = toolNames(makeAgent());

    expect(names).toEqual(['proposeTrack', 'cancelProposal', 'searchNews', 'webSearch']);
    expect(names).not.toContain('applyProposal');
  });

  it('drops webSearch when the user has the toggle off', async () => {
    await setWebSearchInChat(false);
    expect(toolNames(makeAgent())).toEqual(['proposeTrack', 'cancelProposal', 'searchNews']);
  });

  it('offers no retrieval at all on the on-device path', async () => {
    await setProcessingMode('on-device');
    expect(toolNames(makeAgent())).toEqual(['proposeTrack', 'cancelProposal']);
  });

  // THE REGRESSION GUARD for "toggle on, still refuses": the prompt is cached, so if the toggle is
  // not part of the cache key the model keeps being told it cannot search while the tool payload
  // says it can.
  it('rebuilds the system prompt when the web-search toggle flips', async () => {
    const agent = makeAgent();
    await setWebSearchInChat(false);
    const before = await agent.buildSystemPrompt(false);

    await setWebSearchInChat(true);
    const after = await agent.buildSystemPrompt(false);

    expect(after).not.toBe(before);
    expect(after).toContain('webSearch');
  });

  it('executes the retrieval tools instead of refusing them', async () => {
    const seen: Record<string, unknown>[] = [];
    server.use(
      mockGql('SearchNews', (variables) => {
        seen.push(variables);
        return {
          searchNews: [
            { _id: 'a1', title_en: 'Sporting win', image_url: null, publication_name: 'A Bola', country_code: 'PT', pubDate: '2026-10-01T10:00:00.000Z', score: 0.9 },
          ],
        };
      }),
    );
    const agent = makeAgent();

    const news = await agent.executeTool('searchNews', { query: 'Sporting CP' });
    expect(seen).toEqual([{ query: 'Sporting CP', limit: 8 }]);
    expect(news.result).toMatchObject({ query: 'Sporting CP', articles: [{ id: 'a1', title: 'Sporting win' }] });

    const web = await agent.executeTool('webSearch', { queries: ['Sporting CP news'] });
    expect(gatewayCalls('web-search').map((c) => c.messages[0].content)).toEqual(['Sporting CP news']);
    expect(web.result).toMatchObject({ searched: true });
  });
});

describe('FollowStoryAgent: buildContext', () => {
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
    setProposal(proposal);

    const context = await makeAgent().buildContext();

    expect(context).toContain('PENDING SCOPE CARD');
    expect(context).toContain('Russia–Ukraine war');
    expect(context).toContain('cancelProposal');
  });
});

describe('FollowStoryAgent: proposeTrack', () => {
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

  // The article surface embeds the tapped article; there is none here, and every consumer already
  // treats a blank articleId as "no origin article".
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
    await expectNothingFollowed();
  });

  it('stages nothing on its own: proposing never writes', async () => {
    await makeAgent().executeTool('proposeTrack', {
      options: [{ label: 'Ukraine war', search: 'russia ukraine war' }],
    });

    await expectNothingFollowed();
  });
});

describe('FollowStoryAgent: declining and the apply guard', () => {
  it('cancelProposal resolves the card and creates NOTHING', async () => {
    const result = await makeAgent().executeTool('cancelProposal', {});

    expect(result.result).toEqual({ cancelled: true });
    expect(result.sideEffects?.proposalResolved).toBe('cancelled');
    await expectNothingFollowed();
  });

  // A typed "yes" must not follow anything: only the card knows WHICH pill was chosen, so an
  // agent-side apply would mint every scope at once.
  it('refuses a model-invented applyProposal instead of executing the actions', async () => {
    setProposal({
      id: 'p-3',
      explanation: '',
      expectedEffects: '',
      chooseOne: true,
      actions: ['a story', 'b story', 'c story'].map((label) => ({
        type: 'track_story' as const,
        label,
        searchText: label,
        subject: { origin: 'article' as const, surface: FOLLOW_STORY_SURFACE, articleId: '', title: '' },
      })),
    });

    const result = await makeAgent().executeTool('applyProposal', {});

    expect((result.result as { error?: string }).error).toBeTruthy();
    expect(result.sideEffects).toBeUndefined();
    await expectNothingFollowed();
  });

  it('reports an unknown tool without executing anything', async () => {
    const result = await makeAgent().executeTool('proposeChanges', { actions: [] });

    expect((result.result as { error?: string }).error).toContain('Unknown tool');
    await expectNothingFollowed();
  });
});
