// Unit tests for deriveThreadItems — the pure thread-item derivation util.

import type { ConversationMessage, ToolCallRecord } from '@/lib/llm/types';
import { deriveThreadItems } from '../deriveThreadItems';
import type { ChatThreadItem, PersistedMessage } from '../types';

const LABEL = 'Earlier conversation';

function base(
  overrides: Partial<Parameters<typeof deriveThreadItems>[0]> = {},
): Parameters<typeof deriveThreadItems>[0] {
  return {
    live: [],
    history: [],
    introMessage: null,
    isStreaming: false,
    earlierConversationLabel: LABEL,
    ...overrides,
  };
}

function userMsg(id: string, content = 'hello'): ConversationMessage {
  return { id, role: 'user', content };
}

function assistantMsg(
  id: string,
  content: string,
  toolCalls?: ToolCallRecord[],
): ConversationMessage {
  return { id, role: 'assistant', content, toolCalls };
}

function persisted(
  id: string,
  conversationId: string,
  role: 'user' | 'assistant',
  content: string,
  createdAt: number,
  toolCalls: ToolCallRecord[] | null = null,
): PersistedMessage {
  return { id, conversationId, role, content, createdAt, toolCalls };
}

function keys(items: ChatThreadItem[]): string[] {
  return items.map((i) => i.key);
}

describe('deriveThreadItems', () => {
  it('maps a plain live conversation oldest-first, newest last', () => {
    const items = deriveThreadItems(
      base({
        live: [userMsg('u1', 'hi'), assistantMsg('a1', 'hello there')],
      }),
    );

    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({ kind: 'message', key: 'live-u1' });
    expect(items[1]).toMatchObject({ kind: 'message', key: 'live-a1' });
  });

  it('emits the intro pseudo-message as the first live item when set', () => {
    const items = deriveThreadItems(
      base({ introMessage: 'Welcome!', live: [] }),
    );

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: 'message', key: 'live-intro' });
    if (items[0].kind === 'message') {
      expect(items[0].message).toMatchObject({ id: 'intro', role: 'assistant', content: 'Welcome!' });
    }
  });

  it('places the intro before existing live messages', () => {
    const items = deriveThreadItems(
      base({ introMessage: 'Welcome!', live: [userMsg('u1')] }),
    );
    expect(keys(items)).toEqual(['live-intro', 'live-u1']);
  });

  it('emits a pinned article-context card FIRST when articleContext is provided', () => {
    const items = deriveThreadItems(
      base({
        articleContext: { articleId: 'art-1', suggestionId: 'sugg-1', title: 'A story' },
        introMessage: 'Welcome!',
        live: [userMsg('u1', 'hi')],
      }),
    );
    expect(items[0]).toMatchObject({
      kind: 'article-context-card',
      key: 'article-context',
      articleId: 'art-1',
      suggestionId: 'sugg-1',
      title: 'A story',
    });
    expect(keys(items)).toEqual(['article-context', 'live-intro', 'live-u1']);
  });

  it('omits the pinned card when no articleContext is provided', () => {
    const items = deriveThreadItems(base({ live: [userMsg('u1')] }));
    expect(items.some((i) => i.kind === 'article-context-card')).toBe(false);
  });

  it('renders resumed current-conversation messages (no divider) before live, and suppresses intro', () => {
    const items = deriveThreadItems(
      base({
        introMessage: 'Welcome!',
        resume: [
          persisted('r1', 'conv-1', 'user', 'earlier q', 100),
          persisted('r2', 'conv-1', 'assistant', 'earlier a', 200),
        ],
        live: [userMsg('u9', 'new q')],
      }),
    );
    // No intro, no divider — resume then live.
    expect(keys(items)).toEqual(['hist-r1', 'hist-r2', 'live-u9']);
  });

  it('dedupes a live message already present in resume (renders it statically, not animated)', () => {
    const items = deriveThreadItems(
      base({
        resume: [persisted('a1', 'conv-1', 'assistant', 'answer', 100)],
        // Cloud reopen: the same message id is retained in the live store.
        live: [assistantMsg('a1', 'answer')],
      }),
    );
    // Rendered once, via the resume (hist-) key — no duplicate live-a1.
    expect(keys(items)).toEqual(['hist-a1']);
  });

  it('keeps the OLDER-conversation divider between history and resumed current messages', () => {
    const items = deriveThreadItems(
      base({
        history: [persisted('h1', 'conv-0', 'user', 'old', 50)],
        resume: [persisted('r1', 'conv-1', 'user', 'current', 100)],
      }),
    );
    expect(keys(items)).toEqual(['hist-h1', 'div-live', 'hist-r1']);
  });

  it('derives a saved fact card from result.savedFacts', () => {
    const tc: ToolCallRecord = {
      id: 't1',
      name: 'saveExtractedFacts',
      input: {},
      status: 'done',
      result: {
        savedFacts: [
          { id: 'f1', statement: 'Lives in Berlin' },
          { id: 'f2', statement: 'Likes cycling' },
        ],
      },
    };
    const items = deriveThreadItems(
      base({ live: [assistantMsg('a1', 'Saved!', [tc])] }),
    );

    // message + fact-card + one topic-plan-card per saved fact (Wave 11).
    expect(items).toHaveLength(4);
    expect(items[0]).toMatchObject({ kind: 'message', key: 'live-a1' });
    expect(items[1]).toMatchObject({
      kind: 'fact-card',
      key: 'card-a1-0',
      action: 'saved',
      statements: ['Lives in Berlin', 'Likes cycling'],
      factIds: ['f1', 'f2'],
    });
    expect(items[2]).toMatchObject({
      kind: 'topic-plan-card',
      key: 'topic-plan-a1-0-f1',
      factId: 'f1',
      factStatement: 'Lives in Berlin',
    });
    expect(items[3]).toMatchObject({
      kind: 'topic-plan-card',
      key: 'topic-plan-a1-0-f2',
      factId: 'f2',
      factStatement: 'Likes cycling',
    });
  });

  it('falls back to input.extracted_user_information for saved facts (empty factIds)', () => {
    const tc: ToolCallRecord = {
      id: 't1',
      name: 'saveExtractedFacts',
      input: {
        extracted_user_information: [
          { statement: 'Works in tech' },
          'Enjoys jazz',
        ],
      },
      status: 'done',
      result: { success: true, factsSaved: 2 },
    };
    const items = deriveThreadItems(
      base({ live: [assistantMsg('a1', 'Done', [tc])] }),
    );

    const card = items.find((i) => i.kind === 'fact-card');
    expect(card).toMatchObject({
      action: 'saved',
      statements: ['Works in tech', 'Enjoys jazz'],
      factIds: [],
    });
  });

  it('skips a saved card when factsSaved is 0 and no savedFacts present', () => {
    const tc: ToolCallRecord = {
      id: 't1',
      name: 'saveExtractedFacts',
      input: { extracted_user_information: [] },
      status: 'done',
      result: { success: true, factsSaved: 0 },
    };
    const items = deriveThreadItems(
      base({ live: [assistantMsg('a1', 'Nothing new', [tc])] }),
    );
    expect(items.some((i) => i.kind === 'fact-card')).toBe(false);
    expect(items).toHaveLength(1); // just the message
  });

  it('derives a deleted card, preferring result.deletedStatements', () => {
    const tc: ToolCallRecord = {
      id: 't1',
      name: 'deleteUserFacts',
      input: { fact_ids: ['ignored'] },
      status: 'done',
      result: { deletedStatements: ['Lives in Berlin'] },
    };
    const items = deriveThreadItems(
      base({ live: [assistantMsg('a1', 'Removed', [tc])] }),
    );
    const card = items.find((i) => i.kind === 'fact-card');
    expect(card).toMatchObject({ action: 'deleted', statements: ['Lives in Berlin'] });
  });

  it('falls back to input.fact_ids for deleted card', () => {
    const tc: ToolCallRecord = {
      id: 't1',
      name: 'deleteUserFacts',
      input: { fact_ids: ['location: city'] },
      status: 'done',
      result: { success: true, deletedCount: 1 },
    };
    const items = deriveThreadItems(
      base({ live: [assistantMsg('a1', 'Removed', [tc])] }),
    );
    const card = items.find((i) => i.kind === 'fact-card');
    expect(card).toMatchObject({ action: 'deleted', statements: ['location: city'] });
  });

  it('derives an updated card with empty statements', () => {
    const tc: ToolCallRecord = {
      id: 't1',
      name: 'updateUserConfig',
      input: { language_codes: ['de'] },
      status: 'done',
      result: { success: true, language_codes: ['de'] },
    };
    const items = deriveThreadItems(
      base({ live: [assistantMsg('a1', 'Updated', [tc])] }),
    );
    const card = items.find((i) => i.kind === 'fact-card');
    expect(card).toMatchObject({ action: 'updated', statements: [] });
  });

  it('ignores tool calls that are not done', () => {
    const tc: ToolCallRecord = {
      id: 't1',
      name: 'saveExtractedFacts',
      input: { extracted_user_information: [{ statement: 'x' }] },
      status: 'pending',
    };
    const items = deriveThreadItems(
      base({ live: [assistantMsg('a1', 'Working', [tc])] }),
    );
    expect(items.some((i) => i.kind === 'fact-card')).toBe(false);
  });

  it('inserts dividers at conversation boundaries in history and between history and live', () => {
    const items = deriveThreadItems(
      base({
        history: [
          // fetched newest-first
          persisted('m4', 'c2', 'assistant', 'reply 2', 40),
          persisted('m3', 'c2', 'user', 'msg 2', 30),
          persisted('m2', 'c1', 'assistant', 'reply 1', 20),
          persisted('m1', 'c1', 'user', 'msg 1', 10),
        ],
        live: [userMsg('u1', 'now')],
      }),
    );

    expect(keys(items)).toEqual([
      'hist-m1',
      'hist-m2',
      'div-hist-m3', // boundary c1 -> c2
      'hist-m3',
      'hist-m4',
      'div-live', // history -> live boundary
      'live-u1',
    ]);
  });

  it('does not emit a history/live divider when there is no history', () => {
    const items = deriveThreadItems(base({ live: [userMsg('u1')] }));
    expect(items.some((i) => i.key === 'div-live')).toBe(false);
  });

  it('appends a typing item when streaming and no assistant text yet', () => {
    const items = deriveThreadItems(
      base({ live: [userMsg('u1', 'question')], isStreaming: true }),
    );
    expect(items[items.length - 1]).toMatchObject({ kind: 'typing', key: 'typing' });
  });

  it('appends typing when last live assistant message is empty', () => {
    const items = deriveThreadItems(
      base({
        live: [userMsg('u1'), assistantMsg('a1', '')],
        isStreaming: true,
      }),
    );
    expect(items[items.length - 1]).toMatchObject({ kind: 'typing' });
  });

  it('does NOT append typing when the assistant already has streaming text', () => {
    const items = deriveThreadItems(
      base({
        live: [userMsg('u1'), assistantMsg('a1', 'partial answer')],
        isStreaming: true,
      }),
    );
    expect(items.some((i) => i.kind === 'typing')).toBe(false);
  });

  it('skips empty assistant placeholder messages with no cards', () => {
    const items = deriveThreadItems(
      base({ live: [userMsg('u1'), assistantMsg('a1', '   ')] }),
    );
    expect(keys(items)).toEqual(['live-u1']);
  });

  it('keeps an empty assistant message if it carries a fact card', () => {
    const tc: ToolCallRecord = {
      id: 't1',
      name: 'saveExtractedFacts',
      input: {},
      status: 'done',
      result: { savedFacts: [{ id: 'f1', statement: 'Fact' }] },
    };
    const items = deriveThreadItems(
      base({ live: [assistantMsg('a1', '', [tc])] }),
    );
    // Message is skipped (empty content) but the fact-card + topic-plan survive.
    expect(keys(items)).toEqual(['card-a1-0', 'topic-plan-a1-0-f1']);
  });

  it('produces stable, unique keys across history and live', () => {
    const tc: ToolCallRecord = {
      id: 't1',
      name: 'updateUserConfig',
      input: { language_codes: ['de'] },
      status: 'done',
      result: {},
    };
    const items = deriveThreadItems(
      base({
        history: [persisted('m1', 'c1', 'user', 'old', 10)],
        live: [userMsg('u1'), assistantMsg('a1', 'ok', [tc])],
        introMessage: 'hi',
      }),
    );
    const allKeys = keys(items);
    expect(new Set(allKeys).size).toBe(allKeys.length);
    expect(allKeys).toContain('hist-m1');
    expect(allKeys).toContain('div-live');
    expect(allKeys).toContain('live-intro');
    expect(allKeys).toContain('card-a1-0');
  });

  it('Wave 11: does not emit topic-plan cards for saved facts without ids', () => {
    const tc: ToolCallRecord = {
      id: 't1',
      name: 'saveExtractedFacts',
      input: { extracted_user_information: ['Works in tech'] },
      status: 'done',
      result: { success: true, factsSaved: 1 }, // no savedFacts ids
    };
    const items = deriveThreadItems(base({ live: [assistantMsg('a1', 'Done', [tc])] }));
    expect(items.some((i) => i.kind === 'topic-plan-card')).toBe(false);
  });

  it('Wave 11: emits a conflict-card from result.conflicts (before the topic-plan card)', () => {
    const tc: ToolCallRecord = {
      id: 't1',
      name: 'saveExtractedFacts',
      input: {},
      status: 'done',
      result: {
        savedFacts: [{ id: 'n1', statement: 'Lives in Berlin' }],
        conflicts: [
          {
            newFactId: 'n1',
            newStatement: 'Lives in Berlin',
            existingFactId: 'e1',
            existingStatement: 'Lives in Paris',
            kind: 'attribute',
            attributeKey: 'location',
            suggestedMerge: 'Lives in Berlin; Lives in Paris',
          },
        ],
      },
    };
    const items = deriveThreadItems(base({ live: [assistantMsg('a1', 'Saved', [tc])] }));
    const conflictIdx = items.findIndex((i) => i.kind === 'conflict-card');
    const topicIdx = items.findIndex((i) => i.kind === 'topic-plan-card');
    expect(conflictIdx).toBeGreaterThan(-1);
    expect(topicIdx).toBeGreaterThan(conflictIdx);
    const conflictCard = items[conflictIdx];
    expect(conflictCard).toMatchObject({
      kind: 'conflict-card',
      key: 'conflict-a1-0-0',
    });
    if (conflictCard.kind === 'conflict-card') {
      expect(conflictCard.conflict).toMatchObject({
        newFactId: 'n1',
        existingFactId: 'e1',
        kind: 'attribute',
      });
    }
  });

  it('Wave 11: skips malformed conflict entries', () => {
    const tc: ToolCallRecord = {
      id: 't1',
      name: 'saveExtractedFacts',
      input: {},
      status: 'done',
      result: {
        savedFacts: [],
        conflicts: [
          { newFactId: 'n1' }, // missing required fields
          { kind: 'bogus', newFactId: 'n2', newStatement: 'x', existingFactId: 'e2', existingStatement: 'y' },
        ],
      },
    };
    const items = deriveThreadItems(base({ live: [assistantMsg('a1', 'Saved', [tc])] }));
    expect(items.some((i) => i.kind === 'conflict-card')).toBe(false);
  });

  it('emits a proposal-card from a done proposeChanges tool call (rebuilt from input)', () => {
    const tc: ToolCallRecord = {
      id: 'tc-1',
      name: 'proposeChanges',
      status: 'done',
      input: {
        explanation: 'You keep seeing crypto news.',
        expected_effects: 'Fewer crypto suggestions.',
        actions: [
          { type: 'add_fact', statement: 'Not interested in cryptocurrency' },
          { type: 'delete_fact', fact_id: 'f9' },
          { type: 'add_topics', fact_id: 'f2', topics: ['climate policy'] },
        ],
      },
      result: {},
    };
    const items = deriveThreadItems(
      base({ live: [assistantMsg('a1', 'Here is what I propose', [tc])] }),
    );

    expect(items[0]).toMatchObject({ kind: 'message', key: 'live-a1' });
    const card = items.find((i) => i.kind === 'proposal-card');
    expect(card).toMatchObject({ kind: 'proposal-card', key: 'proposal-a1-0' });
    if (card && card.kind === 'proposal-card') {
      expect(card.proposal.id).toBe('tc-1'); // falls back to tool-call id
      expect(card.proposal.explanation).toBe('You keep seeing crypto news.');
      expect(card.proposal.expectedEffects).toBe('Fewer crypto suggestions.');
      expect(card.proposal.actions).toEqual([
        { type: 'add_fact', statement: 'Not interested in cryptocurrency' },
        { type: 'delete_fact', fact_id: 'f9' },
        { type: 'add_topics', fact_id: 'f2', topics: ['climate policy'] },
      ]);
    }
  });

  it('emits a track proposal-card from a done proposeTrack call (subject rebuilt from result)', () => {
    const subject = {
      origin: 'suggestion',
      surface: 'detail',
      articleId: 'art-1',
      title: 'Protest escalates',
      stableClusterId: 'sc-1',
      publicationName: 'The Hindu',
    };
    const tc: ToolCallRecord = {
      id: 'tc-track',
      name: 'proposeTrack',
      status: 'done',
      input: { track: 'Updates on the student protest in Sonbhadra' },
      result: { staged: true, proposalId: 'track-nonce', track: 'Updates on the student protest in Sonbhadra', subject },
    };
    const items = deriveThreadItems(base({ live: [assistantMsg('a1', 'Want to follow this?', [tc])] }));
    const card = items.find((i) => i.kind === 'proposal-card');
    expect(card).toMatchObject({ kind: 'proposal-card' });
    if (card && card.kind === 'proposal-card') {
      expect(card.proposal.id).toBe('track-nonce'); // echoed proposalId wins
      expect(card.proposal.actions).toEqual([
        { type: 'track_story', trackText: 'Updates on the student protest in Sonbhadra', subject },
      ]);
    }
  });

  it('prefers an id echoed by the proposeChanges result over the tool-call id', () => {
    const tc: ToolCallRecord = {
      id: 'tc-1',
      name: 'proposeChanges',
      status: 'done',
      input: {
        explanation: 'x',
        expected_effects: 'y',
        actions: [{ type: 'add_fact', statement: 'Likes hiking' }],
      },
      result: { staged: true, id: 'nonce-42' },
    };
    const items = deriveThreadItems(base({ live: [assistantMsg('a1', 'ok', [tc])] }));
    const card = items.find((i) => i.kind === 'proposal-card');
    if (card && card.kind === 'proposal-card') {
      expect(card.proposal.id).toBe('nonce-42');
    } else {
      throw new Error('expected a proposal-card');
    }
  });

  it('skips a proposeChanges call whose actions are all malformed', () => {
    const tc: ToolCallRecord = {
      id: 'tc-1',
      name: 'proposeChanges',
      status: 'done',
      input: {
        explanation: 'x',
        expected_effects: 'y',
        actions: [
          { type: 'add_fact' }, // missing statement
          { type: 'update_fact', fact_id: 'f1' }, // missing new_statement
          { type: 'bogus' },
        ],
      },
      result: {},
    };
    const items = deriveThreadItems(base({ live: [assistantMsg('a1', 'ok', [tc])] }));
    expect(items.some((i) => i.kind === 'proposal-card')).toBe(false);
  });

  it('parses a submit_feature_request action', () => {
    const tc: ToolCallRecord = {
      id: 'tc-1',
      name: 'proposeChanges',
      status: 'done',
      input: {
        explanation: 'x',
        expected_effects: 'y',
        actions: [
          { type: 'submit_feature_request', title: 'Dark mode toggle', summary: 'Let me switch themes' },
        ],
      },
      result: {},
    };
    const items = deriveThreadItems(base({ live: [assistantMsg('a1', 'ok', [tc])] }));
    const card = items.find((i) => i.kind === 'proposal-card');
    if (card && card.kind === 'proposal-card') {
      expect(card.proposal.actions).toEqual([
        { type: 'submit_feature_request', title: 'Dark mode toggle', summary: 'Let me switch themes' },
      ]);
    } else {
      throw new Error('expected a proposal-card');
    }
  });

  it('resumes Wave-9 rails actions (previously dropped) from a proposeChanges input', () => {
    const tc: ToolCallRecord = {
      id: 'tc-1',
      name: 'proposeChanges',
      status: 'done',
      input: {
        explanation: 'x',
        expected_effects: 'y',
        actions: [
          { type: 'set_topic_weight', topicText: 'cricket', delta: -0.3 },
          { type: 'add_negative_topic', topicText: 'Delhi crime' },
          { type: 'set_publication_pref', publicationId: 'Times of India', publicationPref: 'mute' },
          { type: 'add_suppression', suppressionPattern: 'lottery results', suppressionKeywords: ['lottery'], suppressionStrength: 0.9 },
          { type: 'set_high_priority', topicText: 'AI policy', highPriority: true },
          { type: 'retire_topic', topicText: 'cricket' },
        ],
      },
      result: {},
    };
    const items = deriveThreadItems(base({ live: [assistantMsg('a1', 'proposed', [tc])] }));
    const card = items.find((i) => i.kind === 'proposal-card');
    if (!card || card.kind !== 'proposal-card') throw new Error('expected a proposal-card');
    expect(card.proposal.actions).toEqual([
      { type: 'set_topic_weight', topicText: 'cricket', delta: -0.3 },
      { type: 'add_negative_topic', topicText: 'Delhi crime' },
      { type: 'set_publication_pref', publicationId: 'Times of India', publicationPref: 'mute' },
      { type: 'add_suppression', suppressionPattern: 'lottery results', suppressionKeywords: ['lottery'], suppressionStrength: 0.9 },
      { type: 'set_high_priority', topicText: 'AI policy', highPriority: true },
      { type: 'retire_topic', topicText: 'cricket' },
    ]);
  });

  it('rebuilds a choose_one proposal (single-select) from the tool input', () => {
    const tc: ToolCallRecord = {
      id: 'tc-1',
      name: 'proposeChanges',
      status: 'done',
      input: {
        explanation: 'Less of this?',
        expected_effects: 'Pick one.',
        choose_one: true,
        actions: [
          { type: 'set_topic_weight', topicText: 'cricket', delta: -0.3 },
          { type: 'retire_topic', topicText: 'cricket' },
        ],
      },
      result: { staged: true, chooseOne: true },
    };
    const items = deriveThreadItems(base({ live: [assistantMsg('a1', 'ok', [tc])] }));
    const card = items.find((i) => i.kind === 'proposal-card');
    if (!card || card.kind !== 'proposal-card') throw new Error('expected a proposal-card');
    expect(card.proposal.chooseOne).toBe(true);
    expect(card.proposal.actions).toHaveLength(2);
  });

  it('rebuilds a multi-option track proposal (chooseOne of track_story) from proposeTrack options', () => {
    const subject = {
      origin: 'suggestion',
      surface: 'detail',
      articleId: 'art-1',
      title: 'Protest escalates',
      stableClusterId: 'sc-1',
      publicationName: 'The Hindu',
    };
    const tc: ToolCallRecord = {
      id: 'tc-track',
      name: 'proposeTrack',
      status: 'done',
      input: {
        track: 'The Sonbhadra protest',
        options: ['The Sonbhadra exam-result protest', 'The wider UP exam-reform movement'],
      },
      result: { staged: true, proposalId: 'track-nonce', chooseOne: true, subject },
    };
    const items = deriveThreadItems(base({ live: [assistantMsg('a1', 'Follow which?', [tc])] }));
    const card = items.find((i) => i.kind === 'proposal-card');
    if (!card || card.kind !== 'proposal-card') throw new Error('expected a proposal-card');
    expect(card.proposal.id).toBe('track-nonce');
    expect(card.proposal.chooseOne).toBe(true);
    expect(card.proposal.actions).toEqual([
      { type: 'track_story', trackText: 'The Sonbhadra exam-result protest', subject },
      { type: 'track_story', trackText: 'The wider UP exam-reform movement', subject },
    ]);
  });

  it('emits nothing for applyProposal / cancelProposal tool calls', () => {
    const apply: ToolCallRecord = {
      id: 'tc-1',
      name: 'applyProposal',
      status: 'done',
      input: {},
      result: { proposalResolved: 'applied' },
    };
    const cancel: ToolCallRecord = {
      id: 'tc-2',
      name: 'cancelProposal',
      status: 'done',
      input: {},
      result: { proposalResolved: 'cancelled' },
    };
    const items = deriveThreadItems(
      base({ live: [assistantMsg('a1', 'Applied.', [apply, cancel])] }),
    );
    expect(items.some((i) => i.kind === 'proposal-card')).toBe(false);
    expect(items.some((i) => i.kind === 'fact-card')).toBe(false);
    expect(keys(items)).toEqual(['live-a1']);
  });

  it('normalizes persisted toolCalls: null into undefined and derives cards from history', () => {
    const tc: ToolCallRecord = {
      id: 't1',
      name: 'saveExtractedFacts',
      input: {},
      status: 'done',
      result: { savedFacts: [{ id: 'f1', statement: 'Hist fact' }] },
    };
    const items = deriveThreadItems(
      base({
        history: [
          persisted('m1', 'c1', 'user', 'q', 10),
          persisted('m2', 'c1', 'assistant', 'a', 20, [tc]),
        ],
      }),
    );
    const card = items.find((i) => i.kind === 'fact-card');
    expect(card).toMatchObject({ key: 'card-m2-0', action: 'saved', statements: ['Hist fact'] });
  });
});
