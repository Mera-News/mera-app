// ArticleFeedbackAgent: the article-suggestion feedback chat. It explains WHY an article was
// suggested and STAGES persona changes the user confirms. Real stores, real database (suggestion
// rows, facts, topics, suppressions, feedback verdicts, tracked stories), the real proposal
// executor and the web-search handler over the gateway mock. "The executor was not called" is read
// as "no row changed".
import { getFacts } from '@/lib/database/services/fact-service';
import { countUnprocessedFeedback, recordVerdictFeedback } from '@/lib/database/services/article-feedback-service';
import { addSuppression } from '@/lib/database/services/suppression-service';
import { trackStory } from '@/lib/database/services/tracked-story-service';
import { getActive as getActiveTopics } from '@/lib/database/services/topic-service';
import { ArticleFeedbackAgent } from '@/lib/llm/agents/ArticleFeedbackAgent';
import { useFloatingChatStore } from '@/lib/stores/floating-chat-store';
import { gatewayCalls, server } from '@/test/helpers';
import * as feedbackCore from '@/lib/news-harness/article-feedback/agent-core';
import { setProcessingMode, setWebSearchInChat } from '@/test/integration/chat/_helpers';
import {
  activeTopicTexts,
  factStatements,
  resetAgentWorld,
  seedFactWithTopics,
  seedSuggestion,
  setLanguage,
  setProposal,
  toolNames,
  trackedStoryCount,
} from './agents-kit';
import type { StagedProposal } from '@/lib/llm/types';

jest.setTimeout(30_000);

type Target = { articleId?: string; suggestionId?: string };
const makeAgent = (target: Target = { articleId: 'art-1' }) => new ArticleFeedbackAgent('user-1', target);

const setChatContext = (context: Record<string, unknown>) =>
  useFloatingChatStore.setState({ context: context as never });

beforeEach(async () => {
  await resetAgentWorld();
});
afterEach(() => server.events.removeAllListeners());

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
    setLanguage('fr');
    const prompt = await makeAgent().buildSystemPrompt(false);
    expect(prompt).toContain('French');
  });

  // The cache is observed by counting calls into the REAL builder (a spy, no replacement).
  it('caches the prompt: identical calls build it once', async () => {
    const agent = makeAgent();
    const build = jest.spyOn(feedbackCore, 'buildArticleFeedbackSystemPrompt');
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

  // pivot P6 (F4): the cache key used to omit the web-search toggle, so a prompt built while it was
  // off kept serving stale text after the user flipped it on while getToolDefinitions() declared the
  // tool: the "toggle on, still refuses" bug.
  it('rebuilds (does not serve a stale cache) when the toggle flips, and teaches search once on', async () => {
    const agent = makeAgent();
    await setWebSearchInChat(false);
    const off = await agent.buildSystemPrompt(false);
    expect(off).not.toContain('WEB SEARCH');

    await setWebSearchInChat(true);
    const on = await agent.buildSystemPrompt(false);
    expect(on).not.toBe(off);
    expect(on).toContain('WEB SEARCH');
  });

  it('does not teach search prose when the toggle is on but mode is LOCAL', async () => {
    await setWebSearchInChat(true);
    await setProcessingMode('on-device');
    const prompt = await makeAgent().buildSystemPrompt(false);
    expect(prompt).not.toContain('WEB SEARCH');
  });
});

describe('buildContext', () => {
  it('renders ARTICLE, relevance status, topics, and producing facts', async () => {
    const { factId, topics } = await seedFactWithTopics(
      'Senior ML engineer at DeepMind',
      ['EU AI regulation', 'AI policy'],
      { topics: ['AI', 'ML', 'startups', 'extra'] },
    );
    const { suggestionId } = await seedSuggestion({
      articleId: 'art-1',
      title_en: 'EU passes AI Act',
      description_en: 'The European Union has approved sweeping AI regulation affecting all member states.',
      publication_name: 'Euronews',
      matchedTopics: topics,
      relevance: 0.62,
    });

    const ctx = await makeAgent({ suggestionId }).buildContext();

    expect(ctx).toContain('## ARTICLE');
    expect(ctx).toContain('EU passes AI Act');
    expect(ctx).toContain('Publication: Euronews');
    expect(ctx).toContain('Relevance score: 6.2/10');
    expect(ctx).toContain('- EU AI regulation');
    expect(ctx).toContain('- AI policy');
    // The producing fact is joined in through the topics that matched.
    expect(ctx).toContain(`## FACTS THAT PRODUCED THEM\n- [${factId}] Senior ML engineer at DeepMind`);
    expect(ctx).toContain('## ALL YOUR FACTS');
    // topics preview capped at 3
    expect(ctx).toContain('(topics: AI, ML, startups)');
  });

  it('falls back to the store title and the "not a suggestion" status when no row exists', async () => {
    setChatContext({ kind: 'article-suggestion', articleId: 'art-1', articleTitle: 'A cluster article' });

    const ctx = await makeAgent({ articleId: 'art-1' }).buildContext();

    expect(ctx).toContain('A cluster article');
    expect(ctx).toContain('This article was NOT one of your personalized suggestions.');
  });

  it('marks an unscored suggestion', async () => {
    const { suggestionId } = await seedSuggestion({ articleId: 'art-1' });

    const ctx = await makeAgent({ suggestionId }).buildContext();

    expect(ctx).toContain('scoring has not finished');
  });

  it('injects the PENDING PROPOSAL block when a proposal is staged', async () => {
    const { suggestionId } = await seedSuggestion({ articleId: 'art-1', relevance: 0.5 });
    setProposal({
      id: 'p1',
      explanation: 'You wanted less AI news.',
      expectedEffects: 'Fewer AI stories.',
      actions: [{ type: 'remove_topics', fact_id: 'f1', topics: ['AI'] }],
    });

    const ctx = await makeAgent({ suggestionId }).buildContext();

    expect(ctx).toContain('## PENDING PROPOSAL');
    expect(ctx).toContain('You wanted less AI news.');
    expect(ctx).toContain('applyProposal');
  });

  it('drops the ALL-FACTS block when the context exceeds the token budget', async () => {
    const { suggestionId } = await seedSuggestion({ articleId: 'art-1', relevance: 0.5 });
    // 12 facts with long statements + topics push the assembled context past ~1800 tokens.
    for (let i = 0; i < 12; i += 1) {
      await seedFactWithTopics(`${'x'.repeat(115)} ${i}`, [], { topics: ['a'.repeat(300), 'b'.repeat(300), 'c'.repeat(300)] });
    }

    const ctx = await makeAgent({ suggestionId }).buildContext();

    expect(ctx).not.toContain('## ALL YOUR FACTS');
    // essential blocks survive
    expect(ctx).toContain('## ARTICLE');
  });

  it('lists the ACTIVE filters, so the agent can offer to remove one', async () => {
    const { suggestionId } = await seedSuggestion({ articleId: 'art-1' });
    const filter = await addSuppression({ pattern: 'celebrity gossip', strength: 0.9, source: 'chat' as never });

    const ctx = await makeAgent({ suggestionId }).buildContext();

    expect(ctx).toContain('## YOUR FILTERS');
    expect(ctx).toContain(`[${filter.id}] "celebrity gossip"`);
  });
});

describe('getToolDefinitions', () => {
  it('exposes the proposal + follow + claim-picker tools', () => {
    expect(toolNames(makeAgent())).toEqual([
      'proposeChanges',
      'proposeTrack',
      'applyProposal',
      'cancelProposal',
      // pivot P8c: the Quick fact check chip and the article tick both send into THIS thread, so the
      // claim picker lives on this agent.
      'proposeFactCheck',
    ]);
  });

  // CLOUD-only: its prompt section is ~1,200 measured tokens against a ~3,072-token local input
  // budget, and the check it proposes needs the cloud regardless.
  it('never declares proposeFactCheck in LOCAL mode', async () => {
    await setProcessingMode('on-device');
    await setWebSearchInChat(false);
    expect(toolNames(makeAgent())).not.toContain('proposeFactCheck');
  });

  // pivot P6 (F4): this surface never declared webSearch at all, so the toggle was inert here. These
  // pin BOTH directions of the fix.
  it('omits webSearch when the toggle is off', async () => {
    await setWebSearchInChat(false);
    expect(toolNames(makeAgent())).not.toContain('webSearch');
  });

  it('declares webSearch in CLOUD mode when the toggle is on', async () => {
    await setWebSearchInChat(true);
    expect(toolNames(makeAgent())).toContain('webSearch');
  });

  it('never declares webSearch in LOCAL mode, even with the toggle on', async () => {
    await setProcessingMode('on-device');
    await setWebSearchInChat(true);
    expect(toolNames(makeAgent())).not.toContain('webSearch');
  });
});

describe('executeTool: proposeTrack (follow this story)', () => {
  const trackSubject = {
    origin: 'suggestion' as const,
    surface: 'detail',
    articleId: 'art-1',
    title: 'Protest escalates in Sonbhadra',
    stableClusterId: 'sc-1',
    publicationName: 'The Hindu',
  };
  const makeTrackAgent = () => new ArticleFeedbackAgent('user-1', { articleId: 'art-1' }, trackSubject);

  it('stages a track_story proposal carrying the embedded subject', async () => {
    const result = await makeTrackAgent().executeTool('proposeTrack', {
      options: [{ label: 'Sonbhadra exam protest', search: 'sonbhadra student exam result protest' }],
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
    // Staging only: nothing is followed until a tap.
    expect(await trackedStoryCount()).toBe(0);
  });

  it('declines (no proposal) when the story is already followed, and mints no second topic', async () => {
    await trackStory({ stableClusterId: 'sc-1', articleId: 'art-1', title: trackSubject.title, originSurface: 'detail' });
    const topicsBefore = await activeTopicTexts();

    const result = await makeTrackAgent().executeTool('proposeTrack', { track: 'Updates on the protest' });

    expect(result.result.alreadyTracked).toBe(true);
    expect(result.sideEffects).toBeUndefined();
    expect(await activeTopicTexts()).toEqual(topicsBefore);
    expect(await trackedStoryCount()).toBe(1);
  });

  it('proposes normally when a DIFFERENT story is the one followed', async () => {
    await trackStory({ stableClusterId: 'other-cluster', articleId: 'art-77', title: 'Elsewhere', originSurface: 'detail' });

    const result = await makeTrackAgent().executeTool('proposeTrack', {
      options: [{ label: 'Protest', search: 'sonbhadra protest' }],
    });

    expect(result.result.alreadyTracked).toBeUndefined();
    expect(result.sideEffects?.proposal?.actions).toHaveLength(1);
  });

  it('errors when there is no article subject to follow', async () => {
    // suggestionId-only agent with no trackSubject and no articleId means no subject.
    const result = await makeAgent({ suggestionId: 'sugg-1' }).executeTool('proposeTrack', { track: 'x' });
    expect(result.result.error).toContain('no article to follow');
    expect(result.sideEffects).toBeUndefined();
  });

  it('rejects an empty set of options', async () => {
    const result = await makeTrackAgent().executeTool('proposeTrack', { options: [{ label: '   ', search: '' }] });
    expect(result.result.error).toContain('options is required');
    expect(result.sideEffects).toBeUndefined();
  });
});

describe('executeTool: proposeChanges', () => {
  it('stages a valid proposal and returns it as a side effect', async () => {
    const { factId } = await seedFactWithTopics('AI engineer', []);
    const result = await makeAgent().executeTool('proposeChanges', {
      explanation: 'You wanted less AI news.',
      expected_effects: 'Fewer AI stories.',
      actions: [{ type: 'remove_topics', fact_id: factId, topics: ['AI'] }],
    });

    expect(result.result).toEqual({ staged: true, actionCount: 1, proposalId: result.sideEffects?.proposal?.id });
    expect(result.sideEffects?.proposal?.actions).toHaveLength(1);
    expect(result.sideEffects?.proposal?.id).toMatch(/^proposal-/);
  });

  it('echoes the staged proposal id in the result (deriveThreadItems keys the card on it)', async () => {
    const result = await makeAgent().executeTool('proposeChanges', {
      explanation: 'x',
      expected_effects: 'y',
      actions: [{ type: 'add_fact', statement: 'Likes AI' }],
    });
    expect(result.result.proposalId).toBeDefined();
    expect(result.result.proposalId).toBe(result.sideEffects?.proposal?.id);
    // Staging writes nothing.
    expect(await factStatements()).toEqual([]);
  });

  it('rejects an action referencing an unknown fact_id', async () => {
    await seedFactWithTopics('AI engineer', []);
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
    const result = await makeAgent().executeTool('proposeChanges', {
      explanation: "I'll send this suggestion to the Mera team.",
      expected_effects: "The team will consider it, this won't change your feed today.",
      actions: [
        { type: 'submit_feature_request', title: 'Mute a publication', summary: 'Allow users to mute a publication so its articles stop appearing.' },
      ],
    });
    expect(result.result).toEqual({ staged: true, actionCount: 1, proposalId: result.sideEffects?.proposal?.id });
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

describe('executeTool: applyProposal / cancelProposal', () => {
  const pending = (over: Partial<StagedProposal>): StagedProposal => ({ id: 'p1', explanation: '', expectedEffects: '', actions: [], ...over });

  it('applies the pending proposal through the real executor and resolves it', async () => {
    setProposal(pending({ actions: [{ type: 'add_fact', statement: 'Likes AI' }] }));

    const result = await makeAgent().executeTool('applyProposal', {});

    expect(result.result).toEqual({ applied: 1, errors: [], summaries: [], changeLogIds: [] });
    expect(result.sideEffects?.proposalResolved).toBe('applied');
    expect(await factStatements()).toEqual(['Likes AI']);
  });

  describe('a feed-verdict handoff', () => {
    // A verdict with no tree path is born processed, so the row is seeded WITH one: it starts
    // unprocessed and the stamp has something to do.
    const seedVerdict = () =>
      recordVerdictFeedback({
        articleId: 'art-1',
        sentiment: 'like',
        title: 'EU passes AI Act',
        contextJson: JSON.stringify({ treePath: ['more_like_this'] }),
      });

    it('stamps the feed-verdict feedback processed when a handoff proposal applies', async () => {
      await seedVerdict();
      expect(await countUnprocessedFeedback()).toBe(1);
      setChatContext({ kind: 'article-suggestion', articleId: 'art-1', verdict: 'like' });
      setProposal(pending({ actions: [{ type: 'add_fact', statement: 'X' }] }));

      await makeAgent().executeTool('applyProposal', {});

      expect(await countUnprocessedFeedback()).toBe(0);
    });

    it('does NOT stamp feedback processed when the context carries no verdict', async () => {
      await seedVerdict();
      setChatContext({ kind: 'article-suggestion', articleId: 'art-1' });
      setProposal(pending({ actions: [{ type: 'add_fact', statement: 'X' }] }));

      await makeAgent().executeTool('applyProposal', {});

      expect(await countUnprocessedFeedback()).toBe(1);
    });
  });

  // --- G1: a SINGLE-SELECT card may only be resolved by a tap ---
  //
  // Regression: applyProposal used to hand the executor `proposal.actions` wholesale, so a typed
  // "yes" against a 3-pill proposeTrack card minted three topics AND three followed stories.
  const trackAction = (label: string) => ({
    type: 'track_story' as const,
    label,
    searchText: label.toLowerCase(),
    subject: { origin: 'suggestion' as const, surface: 'detail', articleId: 'art-1', title: 'T' },
  });

  it('REFUSES to apply a chooseOne proposal (3 track pills) from chat: nothing is followed', async () => {
    setProposal(
      pending({
        id: 'track-1',
        chooseOne: true,
        actions: [
          trackAction('Attacks on Ukraine infrastructure'),
          trackAction('Russia–Ukraine war'),
          trackAction('European security crisis'),
        ],
      }),
    );

    const result = await makeAgent().executeTool('applyProposal', {});

    // Nothing is minted: not one pill, not three.
    expect(await activeTopicTexts()).toEqual([]);
    expect(await trackedStoryCount()).toBe(0);
    expect(result.result).toMatchObject({ applied: 0, awaitingUserConfirmation: true });
    // ...and the user is NOT stranded: the card stays pending and tappable, and the model is handed
    // a message it can relay.
    expect(result.sideEffects?.proposalResolved).toBeUndefined();
    expect(typeof result.result.message).toBe('string');
    expect((result.result.message as string).length).toBeGreaterThan(0);
  });

  it('REFUSES a chooseOne proposeChanges card (mutually-exclusive alternatives): the topic is untouched', async () => {
    const { topics } = await seedFactWithTopics('Follows cricket', ['cricket']);
    setProposal(
      pending({
        id: 'p-choose',
        explanation: 'Less of this?',
        expectedEffects: 'Pick how far to go.',
        chooseOne: true,
        actions: [
          { type: 'set_topic_weight', topicText: 'cricket', delta: -0.3 },
          { type: 'retire_topic', topicText: 'cricket' },
        ],
      }),
    );

    const result = await makeAgent().executeTool('applyProposal', {});

    const active = await getActiveTopics();
    expect(active.map((t) => [t.id, t.weight])).toEqual([[topics[0].topicId, 1]]);
    expect(result.result).toMatchObject({ applied: 0, awaitingUserConfirmation: true });
    expect(result.sideEffects?.proposalResolved).toBeUndefined();
  });

  it('still applies a chooseOne proposal that degenerated to ONE action', async () => {
    // `chooseOne` with a single action is not a choice: the card renders as a plain confirm, so the
    // agent must keep applying it or a confirmable proposal becomes unreachable.
    setProposal(pending({ id: 'track-solo', chooseOne: true, actions: [trackAction('Russia–Ukraine war')] }));

    const result = await makeAgent().executeTool('applyProposal', {});

    expect(await activeTopicTexts()).toEqual(['russia–ukraine war']);
    expect(await trackedStoryCount()).toBe(1);
    expect(result.sideEffects?.proposalResolved).toBe('applied');
  });

  it('refuses a run_calibration-only proposal without destroying the card', async () => {
    // The executor silently drops run_calibration unless confirmedByUser, so applying one from chat
    // used to report applied:0 AND resolve the card: the recalibration became unreachable.
    setProposal(pending({ id: 'cal-1', actions: [{ type: 'run_calibration' }] }));

    const result = await makeAgent().executeTool('applyProposal', {});

    expect(gatewayCalls()).toEqual([]);
    expect(result.result).toMatchObject({ applied: 0, awaitingUserConfirmation: true });
    expect(result.sideEffects?.proposalResolved).toBeUndefined();
  });

  it('applies the other actions of a mixed run_calibration proposal, card intact', async () => {
    setProposal(pending({ id: 'cal-mix', actions: [{ type: 'run_calibration' }, { type: 'add_fact', statement: 'Likes AI' }] }));

    const result = await makeAgent().executeTool('applyProposal', {});

    expect(await factStatements()).toEqual(['Likes AI']);
    expect(gatewayCalls()).toEqual([]);
    expect(result.result).toMatchObject({ applied: 1, awaitingUserConfirmation: true });
    expect(result.sideEffects?.proposalResolved).toBeUndefined();
  });

  it('errors when there is no pending proposal to apply', async () => {
    setProposal(null);
    const result = await makeAgent().executeTool('applyProposal', {});
    expect(result.result).toEqual({ error: 'no pending proposal' });
    expect((await getFacts()).length).toBe(0);
  });

  it('cancels a proposal, and the proposal it cancels writes nothing', async () => {
    setProposal(pending({ actions: [{ type: 'add_fact', statement: 'Likes AI' }] }));
    const result = await makeAgent().executeTool('cancelProposal', {});
    expect(result.result).toEqual({ cancelled: true });
    expect(result.sideEffects?.proposalResolved).toBe('cancelled');
    expect(await factStatements()).toEqual([]);
  });

  it('returns an error for an unknown tool', async () => {
    const result = await makeAgent().executeTool('bogus', {});
    expect(result.result.error).toContain('Unknown tool');
  });
});

// pivot P6 (F4): the tool call reaches the shared handler, the same one PersonaUpdateAgent uses,
// including for an UNDECLARED replayed call (toggle now off): the handler re-checks the toggle
// itself, so this must reach it rather than fall into "Unknown tool".
describe('executeTool: webSearch', () => {
  it('delegates to the search handler and returns its result: the query reaches the search route', async () => {
    await setWebSearchInChat(true);

    const result = await makeAgent().executeTool('webSearch', { query: 'eu ai act enforcement' });

    expect(gatewayCalls('web-search').map((c) => c.messages[0].content)).toEqual(['eu ai act enforcement']);
    expect(result.result).toMatchObject({ searched: true });
    expect((result.result.results as { title: string }[])[0].title).toContain('eu ai act enforcement');
  });

  it('still reaches the handler (which itself refuses) for an undeclared replayed call', async () => {
    // No declaration gating here, that is getToolDefinitions' job. This proves the EXECUTION path
    // does not itself gate on the toggle; the handler is the one source of truth for refusing.
    await setWebSearchInChat(false);
    const agent = makeAgent();
    expect(toolNames(agent)).not.toContain('webSearch');

    const result = await agent.executeTool('webSearch', { query: 'x' });

    expect(result.result).toMatchObject({ searched: false });
    expect(result.result.error as string).toContain('switched off');
    expect(gatewayCalls('web-search')).toEqual([]);
  });
});
