// article-feedback-core.test.ts — unit tests for the RN-free brain in
// lib/news-harness/article-feedback/agent-core.ts. No mocks: every export is a
// pure function of its plain inputs.

import {
  buildArticleFeedbackSystemPrompt,
  buildFeedbackContext,
  decideProposeChanges,
  getArticleFeedbackToolDefinitions,
} from '../article-feedback/agent-core';
import type { Fact, SuggestionFeedbackContext, StagedProposal } from '../core/types';

function fact(id: string, statement: string, topics?: string[]): Fact {
  return {
    id,
    statement,
    metadata: topics ? { topics } : undefined,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  };
}

function scoredContext(overrides: Partial<SuggestionFeedbackContext['suggestion']> = {}): SuggestionFeedbackContext {
  return {
    suggestion: {
      title_en: 'EU passes AI Act',
      title_original: null,
      description_en: 'The European Union has approved sweeping AI regulation.',
      publication_name: 'Euronews',
      isScored: true,
      relevance: 0.62,
      reason: 'Relates to your AI engineering work.',
      ...overrides,
    },
    matchedTopicTexts: ['EU AI regulation', 'AI policy'],
    linkedFacts: [{ id: 'f1', statement: 'Senior ML engineer at DeepMind' }],
  };
}

describe('buildArticleFeedbackSystemPrompt', () => {
  it('includes the XML tool-call format block only when needsToolFormat', () => {
    const withFormat = buildArticleFeedbackSystemPrompt({ needsToolFormat: true, languageName: 'English' });
    const withoutFormat = buildArticleFeedbackSystemPrompt({ needsToolFormat: false, languageName: 'English' });
    expect(withFormat).toContain('<tool_call>');
    expect(withFormat).toContain('proposeChanges');
    expect(withoutFormat).not.toContain('<tool_call>');
  });

  it('states capability boundaries and the feature-request escape hatch', () => {
    const prompt = buildArticleFeedbackSystemPrompt({ needsToolFormat: false, languageName: 'English' });
    expect(prompt).toContain('CANNOT');
    expect(prompt).toContain('submit_feature_request');
  });

  it('carries the limited-article-access disclosure', () => {
    const prompt = buildArticleFeedbackSystemPrompt({ needsToolFormat: false, languageName: 'English' });
    expect(prompt).toContain('NEVER the full article text');
    expect(prompt).toContain('source of truth');
  });

  it('pins the language name when provided', () => {
    const prompt = buildArticleFeedbackSystemPrompt({ needsToolFormat: false, languageName: 'French' });
    expect(prompt).toContain('**French**');
  });

  it('falls back to a match-the-user language rule when no language given', () => {
    const prompt = buildArticleFeedbackSystemPrompt({ needsToolFormat: false });
    expect(prompt).toContain("Match the user's language");
  });
});

describe('buildFeedbackContext', () => {
  it('renders ARTICLE, relevance status, topics, and producing facts', () => {
    const ctx = buildFeedbackContext({
      facts: [fact('f1', 'Senior ML engineer at DeepMind', ['AI', 'ML', 'startups', 'extra'])],
      context: scoredContext(),
      fallbackTitle: undefined,
      proposal: null,
    });
    expect(ctx).toContain('## ARTICLE');
    expect(ctx).toContain('EU passes AI Act');
    expect(ctx).toContain('Publication: Euronews');
    expect(ctx).toContain('Relevance score: 6.2/10');
    expect(ctx).toContain('Reason given: "Relates to your AI engineering work."');
    expect(ctx).toContain('EU AI regulation');
    expect(ctx).toContain('[f1] Senior ML engineer at DeepMind');
    expect(ctx).toContain('## ALL YOUR FACTS');
    // topics preview capped at 3
    expect(ctx).toContain('(topics: AI, ML, startups)');
    expect(ctx).not.toContain('extra');
  });

  it('falls back to the store title and the "not a suggestion" status when context is null', () => {
    const ctx = buildFeedbackContext({
      facts: [],
      context: null,
      fallbackTitle: 'A cluster article',
      proposal: null,
    });
    expect(ctx).toContain('A cluster article');
    expect(ctx).toContain('This article was NOT one of your personalized suggestions.');
    // No suggestion → matched topics / producing facts render "None."
    expect(ctx).toContain('## MATCHED TOPICS\nNone.');
    expect(ctx).toContain('## FACTS THAT PRODUCED THEM\nNone.');
  });

  it('marks an unscored suggestion (not yet scored)', () => {
    const ctx = buildFeedbackContext({
      facts: [],
      context: scoredContext({ isScored: false, relevance: 0, reason: '' }),
      fallbackTitle: undefined,
      proposal: null,
    });
    expect(ctx).toContain('scoring has not finished');
  });

  it('omits the reason clause when a scored suggestion has no reason', () => {
    const ctx = buildFeedbackContext({
      facts: [],
      context: scoredContext({ reason: '' }),
      fallbackTitle: undefined,
      proposal: null,
    });
    expect(ctx).toContain('Relevance score: 6.2/10.');
    expect(ctx).not.toContain('Reason given');
  });

  it('injects the PENDING PROPOSAL block when a proposal is staged', () => {
    const proposal: StagedProposal = {
      id: 'p1',
      explanation: 'You wanted less AI news.',
      expectedEffects: 'Fewer AI stories.',
      actions: [{ type: 'remove_topics', fact_id: 'f1', topics: ['AI'] }],
    };
    const ctx = buildFeedbackContext({
      facts: [],
      context: scoredContext(),
      fallbackTitle: undefined,
      proposal,
    });
    expect(ctx).toContain('## PENDING PROPOSAL');
    expect(ctx).toContain('You wanted less AI news.');
    expect(ctx).toContain('remove topics from [f1]: AI');
    expect(ctx).toContain('applyProposal');
  });

  it('describes every action variant in the PENDING PROPOSAL block', () => {
    const proposal: StagedProposal = {
      id: 'p2',
      explanation: 'Mixed changes.',
      expectedEffects: 'Various.',
      actions: [
        { type: 'add_fact', statement: 'Likes AI' },
        { type: 'update_fact', fact_id: 'f1', new_statement: 'Staff engineer' },
        { type: 'delete_fact', fact_id: 'f2' },
        { type: 'add_topics', fact_id: 'f1', topics: ['ML'] },
        { type: 'remove_topics', fact_id: 'f1', topics: ['crypto'] },
        { type: 'submit_feature_request', title: 'Mute publications', summary: 'Mute a source.' },
        { type: 'set_topic_weight', topicText: 'cricket', delta: -0.3 },
        { type: 'add_negative_topic', topicText: 'Delhi crime' },
        { type: 'set_publication_pref', publicationId: 'Times of India', publicationPref: 'mute' },
        { type: 'add_suppression', suppressionPattern: 'lottery results' },
        { type: 'set_high_priority', topicText: 'AI policy', highPriority: true },
      ],
    };
    const ctx = buildFeedbackContext({ facts: [], context: null, fallbackTitle: 'T', proposal });
    expect(ctx).toContain('add fact "Likes AI"');
    expect(ctx).toContain('update [f1] → "Staff engineer"');
    expect(ctx).toContain('delete [f2]');
    expect(ctx).toContain('add topics to [f1]: ML');
    expect(ctx).toContain('remove topics from [f1]: crypto');
    expect(ctx).toContain('send feature request "Mute publications" to the Mera team');
    expect(ctx).toContain('show less of "cricket"');
    expect(ctx).toContain('down-rank "Delhi crime"');
    expect(ctx).toContain('mute publication "Times of India"');
    expect(ctx).toContain('suppress "lottery results"');
    expect(ctx).toContain('pin topic "AI policy"');
  });

  it('drops the ALL-FACTS block when the context exceeds the token budget', () => {
    const bigStatement = 'x'.repeat(115);
    const facts = Array.from({ length: 12 }, (_, i) =>
      fact(`f${i}`, bigStatement, ['a'.repeat(300), 'b'.repeat(300), 'c'.repeat(300)]),
    );
    const ctx = buildFeedbackContext({
      facts,
      context: scoredContext({ isScored: true }),
      fallbackTitle: undefined,
      proposal: null,
    });
    expect(ctx).not.toContain('## ALL YOUR FACTS');
    // essential blocks survive
    expect(ctx).toContain('## ARTICLE');
    expect(ctx).toContain('## SUGGESTION STATUS');
  });

  it('caps matched topics and producing facts to their limits', () => {
    const manyTopics = Array.from({ length: 15 }, (_, i) => `topic-${i}`);
    const manyFacts = Array.from({ length: 8 }, (_, i) => ({ id: `lf${i}`, statement: `producing ${i}` }));
    const ctx = buildFeedbackContext({
      facts: [],
      context: {
        suggestion: scoredContext().suggestion,
        matchedTopicTexts: manyTopics,
        linkedFacts: manyFacts,
      },
      fallbackTitle: undefined,
      proposal: null,
    });
    expect(ctx).toContain('topic-9'); // 10th matched topic (index 9) present
    expect(ctx).not.toContain('topic-10'); // capped at 10
    expect(ctx).toContain('[lf4] producing 4'); // 5th producing fact present
    expect(ctx).not.toContain('[lf5] producing 5'); // capped at 5
  });
});

describe('getArticleFeedbackToolDefinitions', () => {
  it('exposes the three proposal tools in order', () => {
    const names = getArticleFeedbackToolDefinitions().map((t) => t.function.name);
    expect(names).toEqual(['proposeChanges', 'applyProposal', 'cancelProposal']);
  });

  it('declares the proposeChanges required params and action enum', () => {
    const propose = getArticleFeedbackToolDefinitions()[0];
    expect(propose.function.parameters.required).toEqual(['explanation', 'expected_effects', 'actions']);
    const actionType = (propose.function.parameters.properties.actions as {
      items: { properties: { type: { enum: string[] } } };
    }).items.properties.type.enum;
    expect(actionType).toEqual([
      'add_fact',
      'update_fact',
      'delete_fact',
      'add_topics',
      'remove_topics',
      'submit_feature_request',
      'set_topic_weight',
      'add_negative_topic',
      'set_publication_pref',
      'add_suppression',
      'set_high_priority',
    ]);
  });

  it('declares the Wave-9 rails params on the proposeChanges action schema', () => {
    const propose = getArticleFeedbackToolDefinitions()[0];
    const props = (propose.function.parameters.properties.actions as {
      items: { properties: Record<string, unknown> };
    }).items.properties;
    for (const key of ['topicText', 'delta', 'weight', 'publicationId', 'publicationPref', 'suppressionPattern', 'highPriority']) {
      expect(props[key]).toBeDefined();
    }
    expect((props.publicationPref as { enum: string[] }).enum).toEqual(['boost', 'deprioritize', 'mute']);
  });
});

describe('decideProposeChanges', () => {
  it('stages a valid proposal and returns it as a side effect', () => {
    const result = decideProposeChanges(
      {
        explanation: 'You wanted less AI news.',
        expected_effects: 'Fewer AI stories.',
        actions: [{ type: 'remove_topics', fact_id: 'f1', topics: ['AI'] }],
      },
      new Set(['f1']),
    );
    expect(result.result).toEqual({
      staged: true,
      actionCount: 1,
      proposalId: result.sideEffects?.proposal?.id,
    });
    expect(result.sideEffects?.proposal?.actions).toHaveLength(1);
    expect(result.sideEffects?.proposal?.id).toMatch(/^proposal-/);
  });

  it('echoes the staged proposal id in the result', () => {
    const result = decideProposeChanges(
      { explanation: 'x', expected_effects: 'y', actions: [{ type: 'add_fact', statement: 'Likes AI' }] },
      new Set(),
    );
    expect(result.result.proposalId).toBeDefined();
    expect(result.result.proposalId).toBe(result.sideEffects?.proposal?.id);
  });

  it('validates and stages a submit_feature_request action (no fact_id needed)', () => {
    const result = decideProposeChanges(
      {
        explanation: "I'll send this suggestion to the Mera team.",
        expected_effects: "The team will consider it — this won't change your feed today.",
        actions: [
          { type: 'submit_feature_request', title: 'Mute a publication', summary: 'Allow users to mute a publication so its articles stop appearing.' },
        ],
      },
      new Set(),
    );
    expect(result.sideEffects?.proposal?.actions[0]).toEqual({
      type: 'submit_feature_request',
      title: 'Mute a publication',
      summary: 'Allow users to mute a publication so its articles stop appearing.',
    });
  });

  it('rejects an action referencing an unknown fact_id (no side effect)', () => {
    const result = decideProposeChanges(
      { explanation: 'x', expected_effects: 'y', actions: [{ type: 'delete_fact', fact_id: 'ghost' }] },
      new Set(['f1']),
    );
    expect(result.result.error).toContain('ghost');
    expect(result.sideEffects).toBeUndefined();
  });

  it('rejects a missing explanation', () => {
    const result = decideProposeChanges(
      { expected_effects: 'y', actions: [{ type: 'add_fact', statement: 'Likes AI' }] },
      new Set(),
    );
    expect(result.result.error).toContain('explanation');
  });

  it('rejects a missing expected_effects', () => {
    const result = decideProposeChanges(
      { explanation: 'x', actions: [{ type: 'add_fact', statement: 'Likes AI' }] },
      new Set(),
    );
    expect(result.result.error).toContain('expected_effects');
  });

  it('rejects an empty actions array', () => {
    const result = decideProposeChanges({ explanation: 'x', expected_effects: 'y', actions: [] }, new Set());
    expect(result.result.error).toContain('actions');
  });

  it('rejects a submit_feature_request with an over-long title', () => {
    const result = decideProposeChanges(
      { explanation: 'x', expected_effects: 'y', actions: [{ type: 'submit_feature_request', title: 'z'.repeat(81), summary: 'ok' }] },
      new Set(),
    );
    expect(result.result.error).toContain('title');
  });

  it('rejects a submit_feature_request with a missing summary', () => {
    const result = decideProposeChanges(
      { explanation: 'x', expected_effects: 'y', actions: [{ type: 'submit_feature_request', title: 'Mute', summary: '' }] },
      new Set(),
    );
    expect(result.result.error).toContain('summary');
  });

  it('rejects a submit_feature_request with an over-long summary', () => {
    const result = decideProposeChanges(
      { explanation: 'x', expected_effects: 'y', actions: [{ type: 'submit_feature_request', title: 'Mute', summary: 's'.repeat(501) }] },
      new Set(),
    );
    expect(result.result.error).toContain('summary');
  });

  it('stages a valid update_fact, delete_fact, and add_topics', () => {
    const result = decideProposeChanges(
      {
        explanation: 'x',
        expected_effects: 'y',
        actions: [
          { type: 'update_fact', fact_id: 'f1', new_statement: 'Now a staff engineer' },
          { type: 'delete_fact', fact_id: 'f2' },
          { type: 'add_topics', fact_id: 'f1', topics: ['ML', ' ', 'AI'] },
        ],
      },
      new Set(['f1', 'f2']),
    );
    expect(result.result.actionCount).toBe(3);
    const actions = result.sideEffects?.proposal?.actions;
    expect(actions?.[0]).toEqual({ type: 'update_fact', fact_id: 'f1', new_statement: 'Now a staff engineer' });
    expect(actions?.[1]).toEqual({ type: 'delete_fact', fact_id: 'f2' });
    // blank topic entries are stripped
    expect(actions?.[2]).toEqual({ type: 'add_topics', fact_id: 'f1', topics: ['ML', 'AI'] });
  });

  it('rejects update_fact with an empty new_statement', () => {
    const result = decideProposeChanges(
      { explanation: 'x', expected_effects: 'y', actions: [{ type: 'update_fact', fact_id: 'f1', new_statement: '  ' }] },
      new Set(['f1']),
    );
    expect(result.result.error).toContain('new_statement');
  });

  it('rejects add_topics with an empty topics array', () => {
    const result = decideProposeChanges(
      { explanation: 'x', expected_effects: 'y', actions: [{ type: 'add_topics', fact_id: 'f1', topics: [] }] },
      new Set(['f1']),
    );
    expect(result.result.error).toContain('topics');
  });

  it('rejects add_fact with an empty statement', () => {
    const result = decideProposeChanges(
      { explanation: 'x', expected_effects: 'y', actions: [{ type: 'add_fact', statement: '   ' }] },
      new Set(),
    );
    expect(result.result.error).toContain('statement');
  });

  it('maps each Wave-9 rails action to its ProposalAction shape', () => {
    const result = decideProposeChanges(
      {
        explanation: 'x',
        expected_effects: 'y',
        actions: [
          { type: 'set_topic_weight', topicText: 'cricket', delta: -0.3 },
          { type: 'add_negative_topic', topicText: 'Delhi crime' },
          { type: 'set_publication_pref', publicationId: 'Times of India', publicationPref: 'mute' },
          { type: 'add_suppression', suppressionPattern: 'lottery results' },
          { type: 'set_high_priority', topicText: 'AI policy', highPriority: true },
        ],
      },
      new Set(),
    );
    const actions = result.sideEffects?.proposal?.actions;
    expect(actions).toHaveLength(5);
    expect(actions?.[0]).toEqual({ type: 'set_topic_weight', topicText: 'cricket', delta: -0.3 });
    expect(actions?.[1]).toEqual({ type: 'add_negative_topic', topicText: 'Delhi crime' });
    expect(actions?.[2]).toEqual({ type: 'set_publication_pref', publicationId: 'Times of India', publicationPref: 'mute' });
    expect(actions?.[3]).toEqual({ type: 'add_suppression', suppressionPattern: 'lottery results' });
    expect(actions?.[4]).toEqual({ type: 'set_high_priority', topicText: 'AI policy', highPriority: true });
  });

  it('clamps an over-large set_topic_weight delta to the gentle-nudge bound', () => {
    const result = decideProposeChanges(
      { explanation: 'x', expected_effects: 'y', actions: [{ type: 'set_topic_weight', topicText: 'cricket', delta: -5 }] },
      new Set(),
    );
    expect(result.sideEffects?.proposal?.actions[0]).toEqual({ type: 'set_topic_weight', topicText: 'cricket', delta: -0.5 });
  });

  it('carries an explicit add_negative_topic weight when provided', () => {
    const result = decideProposeChanges(
      { explanation: 'x', expected_effects: 'y', actions: [{ type: 'add_negative_topic', topicText: 'crypto', weight: -0.8 }] },
      new Set(),
    );
    expect(result.sideEffects?.proposal?.actions[0]).toEqual({ type: 'add_negative_topic', topicText: 'crypto', weight: -0.8 });
  });

  it('rejects invalid Wave-9 rails actions', () => {
    expect(
      decideProposeChanges(
        { explanation: 'x', expected_effects: 'y', actions: [{ type: 'set_topic_weight', topicText: '', delta: -0.3 }] },
        new Set(),
      ).result.error,
    ).toContain('topicText');
    expect(
      decideProposeChanges(
        { explanation: 'x', expected_effects: 'y', actions: [{ type: 'set_topic_weight', topicText: 'cricket', delta: 0 }] },
        new Set(),
      ).result.error,
    ).toContain('delta');
    expect(
      decideProposeChanges(
        { explanation: 'x', expected_effects: 'y', actions: [{ type: 'set_publication_pref', publicationId: 'X', publicationPref: 'ban' }] },
        new Set(),
      ).result.error,
    ).toContain('publicationPref');
    expect(
      decideProposeChanges(
        { explanation: 'x', expected_effects: 'y', actions: [{ type: 'add_suppression', suppressionPattern: '  ' }] },
        new Set(),
      ).result.error,
    ).toContain('suppressionPattern');
    expect(
      decideProposeChanges(
        { explanation: 'x', expected_effects: 'y', actions: [{ type: 'set_high_priority', topicText: 'AI', highPriority: 'yes' }] },
        new Set(),
      ).result.error,
    ).toContain('highPriority');
  });

  it('rejects a non-object action and an unknown action type', () => {
    const nonObject = decideProposeChanges(
      { explanation: 'x', expected_effects: 'y', actions: [42] },
      new Set(),
    );
    expect(nonObject.result.error).toContain('object');

    const badType = decideProposeChanges(
      { explanation: 'x', expected_effects: 'y', actions: [{ type: 'nuke_everything' }] },
      new Set(),
    );
    expect(badType.result.error).toContain('invalid action type');
  });
});
