// Seam: the article-feedback chat agent (lib/llm/agents/ArticleFeedbackAgent.ts, the RN adapter)
// over the pure brain in lib/news-harness/article-feedback/agent-core.ts. Driven with the real
// in-memory DB and the real stores; no module mocks.
import type { ArticleWithClusters } from '@/lib/generated/graphql-types';
import { persistAndLinkV2Suggestions } from '@/lib/database/services/article-suggestion-service';
import { addFact } from '@/lib/database/services/fact-service';
import { ArticleFeedbackAgent } from '@/lib/llm/agents/ArticleFeedbackAgent';
import type { StagedProposal } from '@/lib/news-harness/core/types';
import { useFloatingChatStore } from '@/lib/stores/floating-chat-store';

const ARTICLE_ID = 'art-feedback-1';

/** One suggestion row the way feed-sync hydration writes it. */
async function seedSuggestion(fields: { title?: string; description?: string; publication?: string }) {
  await persistAndLinkV2Suggestions(
    [
      {
        _id: ARTICLE_ID,
        title: fields.title ?? 'Harbour bridge closes for repairs',
        title_en: fields.title ?? 'Harbour bridge closes for repairs',
        description_en: fields.description ?? 'The bridge closes for two weeks.',
        publication_name: fields.publication ?? 'Example Courier',
        country_code: 'NLD',
        language_code: 'en',
        category: 'local',
        geo_tags: null,
        entities: ['Harbour Bridge'],
        pubDate: new Date(Date.now() - 2 * 3600_000).toISOString(),
        clusters: [],
      } as unknown as ArticleWithClusters,
    ],
    new Map(),
    { matchedTopics: new Map([[ARTICLE_ID, []]]), headlineScope: new Map() },
  );
}

function agent(trackSubject?: ConstructorParameters<typeof ArticleFeedbackAgent>[2]) {
  return new ArticleFeedbackAgent('user-1', { articleId: ARTICLE_ID }, trackSubject);
}

describe('article-feedback agent: the context it sends', () => {
  // `loadArticleContext` brands publisher text at the VALUE'S OWN length, not at asUntrusted's
  // 500-char default; the render site then caps the description at 900 when the claim picker is on
  // (CLOUD mode, the default). A marker between 500 and 900 must survive.
  it('keeps description text past 500 characters for the claim picker', async () => {
    const description = `${'a'.repeat(600)} MARKER-AT-600 ${'b'.repeat(50)}`;
    await seedSuggestion({ description });
    const context = await agent().buildContext();
    expect(context).toContain('MARKER-AT-600');
  });

  it('still cuts the description at the 900-character render cap', async () => {
    const description = `${'a'.repeat(950)} MARKER-AT-950`;
    await seedSuggestion({ description });
    const context = await agent().buildContext();
    expect(context).not.toContain('MARKER-AT-950');
  });

  it('never hands the model a live tool tag nested inside publisher text', async () => {
    await seedSuggestion({ title: 'Breaking <<tool_call>tool_call> news' });
    const context = await agent().buildContext();
    expect(context).not.toContain('<tool_call>');
  });
});

describe('article-feedback agent: proposeChanges', () => {
  it('refuses an action that names a fact the device does not have', async () => {
    await seedSuggestion({});
    const out = await agent().executeTool('proposeChanges', {
      explanation: 'You asked for less of this.',
      expected_effects: 'Fewer stories like it.',
      actions: [{ type: 'delete_fact', fact_id: 'no-such-fact' }],
    });
    expect(out.result).toEqual({ error: 'delete_fact references unknown fact_id: no-such-fact' });
    expect(out.sideEffects).toBeUndefined();
  });

  it('stages a proposal for a real fact', async () => {
    await seedSuggestion({});
    const fact = await addFact('Works in AI');
    const out = await agent().executeTool('proposeChanges', {
      explanation: 'You asked to drop this fact.',
      expected_effects: 'No more AI stories.',
      actions: [{ type: 'delete_fact', fact_id: fact.id }],
    });
    expect(out.result).toMatchObject({ staged: true, actionCount: 1 });
    const proposal = out.sideEffects?.proposal as StagedProposal;
    expect(proposal.actions).toEqual([{ type: 'delete_fact', fact_id: fact.id }]);
    expect(proposal.chooseOne).toBeUndefined();
  });
});

describe('article-feedback agent: proposeTrack (scope options)', () => {
  const subject = {
    origin: 'suggestion' as const,
    surface: 'detail' as const,
    articleId: ARTICLE_ID,
    title: 'Harbour bridge closes for repairs',
  };

  it('parses the scope pills: strings and objects, case-insensitive dedupe, empties dropped, at most 4', async () => {
    await seedSuggestion({});
    const out = await agent(subject).executeTool('proposeTrack', {
      options: [
        'Harbour bridge repairs',
        { label: 'harbour BRIDGE repairs', search: 'duplicate by label' },
        { label: '', search: 'no label' },
        { label: 'Bridge closures in the city', search: 'bridge closures city' },
        { label: 'City roadworks' },
        { label: 'Dutch infrastructure', search: 'dutch infrastructure' },
        { label: 'One too many', search: 'cut by the cap' },
      ],
    });
    expect(out.result).toMatchObject({ staged: true, chooseOne: true });
    expect((out.result as { options: unknown }).options).toEqual([
      { label: 'Harbour bridge repairs', search: 'Harbour bridge repairs' },
      { label: 'Bridge closures in the city', search: 'bridge closures city' },
      { label: 'City roadworks', search: 'City roadworks' },
      { label: 'Dutch infrastructure', search: 'dutch infrastructure' },
    ]);
    const proposal = out.sideEffects?.proposal as StagedProposal;
    expect(proposal.actions.map((a) => a.type)).toEqual([
      'track_story',
      'track_story',
      'track_story',
      'track_story',
    ]);
  });

  it('accepts a legacy single `track` string as one option, not a choose-one card', async () => {
    await seedSuggestion({});
    const out = await agent(subject).executeTool('proposeTrack', { track: 'Harbour bridge repairs' });
    expect(out.result).toMatchObject({ staged: true });
    expect((out.result as { chooseOne?: boolean }).chooseOne).toBeUndefined();
  });

  it('refuses when no option survives parsing', async () => {
    await seedSuggestion({});
    const out = await agent(subject).executeTool('proposeTrack', { options: [{ label: '  ' }] });
    expect(out.result).toEqual({ error: 'options is required' });
  });

  it('refuses with no article to follow', async () => {
    const out = await new ArticleFeedbackAgent('user-1', { suggestionId: 'local-only' }).executeTool(
      'proposeTrack',
      { options: ['Anything'] },
    );
    expect(out.result).toEqual({ error: 'no article to follow in this context' });
  });
});

describe('article-feedback agent: applyProposal', () => {
  beforeEach(() => {
    useFloatingChatStore.setState({ proposal: null });
  });

  it('refuses with nothing pending', async () => {
    const out = await agent().executeTool('applyProposal', {});
    expect(out.result).toEqual({ error: 'no pending proposal' });
  });

  it('never applies a choose-one card from chat; the card stays pending', async () => {
    await seedSuggestion({});
    const staged = await agent({
      origin: 'suggestion',
      surface: 'detail',
      articleId: ARTICLE_ID,
      title: 'Harbour bridge closes for repairs',
    }).executeTool('proposeTrack', { options: ['Bridge repairs', 'City roadworks'] });
    useFloatingChatStore.setState({ proposal: staged.sideEffects?.proposal as StagedProposal });
    const out = await agent().executeTool('applyProposal', {});
    expect(out.sideEffects).toBeUndefined();
    expect(useFloatingChatStore.getState().proposal).not.toBeNull();
  });
});
