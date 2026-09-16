// Per-group fact-choice derivation: what cards one `saveExtractedFacts` call
// produces, and in what ORDER.
//
// Order is the product requirement here, not a detail, so every assertion below
// is on the sequence of item kinds rather than on their presence. "Replaced in
// line, at its own position" is only observable as a sequence.

import { factChoiceGroupId } from '@/lib/chat-tools/fact-choice-resolution';
import { deriveThreadItems } from '../deriveThreadItems';
import type { ChatThreadItem } from '../types';

const MSG = 'm1';

function stagedResult(optionSets: string[][]): Record<string, unknown> {
  return {
    success: true,
    staged: true,
    factsSaved: 0,
    savedFacts: [],
    conflicts: [],
    groupResolutions: {},
    pendingFacts: optionSets.map((options, index) => ({
      index,
      groupId: factChoiceGroupId(index, options),
      options,
      questionnaireAttribute: null,
    })),
  };
}

function withResolutions(
  base: Record<string, unknown>,
  resolutions: Record<string, unknown>,
): Record<string, unknown> {
  return { ...base, groupResolutions: resolutions };
}

function itemsFor(result: Record<string, unknown>): ChatThreadItem[] {
  return deriveThreadItems({
    live: [
      {
        id: MSG,
        role: 'assistant',
        content: 'Got it.',
        toolCalls: [
          {
            id: 'tc-0',
            name: 'saveExtractedFacts',
            status: 'done',
            input: {},
            result,
          },
        ],
      },
    ],
    history: [],
    introMessage: null,
    isStreaming: false,
    earlierConversationLabel: 'Earlier',
  });
}

const kinds = (items: ChatThreadItem[]) => items.map((i) => i.kind);

const saved = (statement: string, id: string, batch = false) => ({
  status: 'saved',
  statements: [statement],
  savedFacts: [{ id, statement }],
  conflicts: [],
  ...(batch ? { batch: true } : {}),
});

describe('fact-choice group derivation', () => {
  const THREE = [['Lives in Hoorn'], ['Works as a farmer'], ['Parents in Malaga']];

  it('emits one card per extracted fact, plus one bulk row after the last', () => {
    const items = itemsFor(stagedResult(THREE));
    expect(kinds(items)).toEqual([
      'message',
      'fact-choice-card',
      'fact-choice-card',
      'fact-choice-card',
      'fact-choice-bulk-row',
    ]);
  });

  it('REGRESSION: accepting the MIDDLE group leaves its siblings tappable, in place', () => {
    const base = stagedResult(THREE);
    const gid = factChoiceGroupId(1, ['Works as a farmer']);
    const items = itemsFor(
      withResolutions(base, { [gid]: saved('Works as a farmer', 'f2') }),
    );

    // Group 0 stays pending at the top, group 1 is replaced AT ITS OWN POSITION
    // by its Saved card and its own topics card, group 2 stays pending below.
    expect(kinds(items)).toEqual([
      'message',
      'fact-choice-card',
      'fact-card',
      'chat-topics-card',
      'fact-choice-card',
      'fact-choice-bulk-row',
    ]);

    const factCard = items.find((i) => i.kind === 'fact-card');
    expect(factCard).toMatchObject({ statements: ['Works as a farmer'] });
    // The two survivors are the ones that were NOT resolved.
    const pending = items.filter(
      (i): i is Extract<ChatThreadItem, { kind: 'fact-choice-card' }> =>
        i.kind === 'fact-choice-card',
    );
    expect(pending.map((p) => p.groupIndex)).toEqual([0, 2]);
    expect(pending.every((p) => !p.dismissed)).toBe(true);
  });

  it('renders a skipped group as a dismissed card in place, not as a gap', () => {
    const base = stagedResult(THREE);
    const gid = factChoiceGroupId(0, ['Lives in Hoorn']);
    const items = itemsFor(
      withResolutions(base, {
        [gid]: { status: 'dismissed', options: ['Lives in Hoorn'], questionnaireAttribute: null },
      }),
    );
    const cards = items.filter(
      (i): i is Extract<ChatThreadItem, { kind: 'fact-choice-card' }> =>
        i.kind === 'fact-choice-card',
    );
    expect(cards.map((c) => [c.groupIndex, c.dismissed])).toEqual([
      [0, true],
      [1, false],
      [2, false],
    ]);
  });

  it('drops the bulk row once fewer than two groups are pending', () => {
    const base = stagedResult(THREE);
    const g0 = factChoiceGroupId(0, ['Lives in Hoorn']);
    const g1 = factChoiceGroupId(1, ['Works as a farmer']);
    const items = itemsFor(
      withResolutions(base, { [g0]: saved('Lives in Hoorn', 'f1'), [g1]: saved('Works as a farmer', 'f2') }),
    );
    expect(kinds(items)).not.toContain('fact-choice-bulk-row');
  });

  it('never emits a bulk row for a single-group turn', () => {
    const items = itemsFor(stagedResult([['Lives in Hoorn']]));
    expect(kinds(items)).toEqual(['message', 'fact-choice-card']);
  });

  it('places the bulk row after the LAST pending card, below a resolved sibling', () => {
    const base = stagedResult(THREE);
    const g0 = factChoiceGroupId(0, ['Lives in Hoorn']);
    const items = itemsFor(withResolutions(base, { [g0]: saved('Lives in Hoorn', 'f1') }));
    const bulkAt = items.findIndex((i) => i.kind === 'fact-choice-bulk-row');
    const lastPendingAt = items.map((i) => i.kind).lastIndexOf('fact-choice-card');
    expect(bulkAt).toBe(lastPendingAt + 1);
  });

  it('bulk row carries only the groups still pending', () => {
    const base = stagedResult(THREE);
    const g0 = factChoiceGroupId(0, ['Lives in Hoorn']);
    const items = itemsFor(withResolutions(base, { [g0]: saved('Lives in Hoorn', 'f1') }));
    const row = items.find(
      (i): i is Extract<ChatThreadItem, { kind: 'fact-choice-bulk-row' }> =>
        i.kind === 'fact-choice-bulk-row',
    );
    expect(row?.groups.map((g) => g.groupIndex)).toEqual([1, 2]);
  });

  it('batch-accepted groups pool into ONE merged topics card after the group', () => {
    const base = stagedResult(THREE);
    const items = itemsFor(
      withResolutions(base, {
        [factChoiceGroupId(0, ['Lives in Hoorn'])]: saved('Lives in Hoorn', 'f1', true),
        [factChoiceGroupId(1, ['Works as a farmer'])]: saved('Works as a farmer', 'f2', true),
        [factChoiceGroupId(2, ['Parents in Malaga'])]: saved('Parents in Malaga', 'f3', true),
      }),
    );
    // Three Saved cards in line, then ONE merged topics card.
    expect(kinds(items)).toEqual([
      'message',
      'fact-card',
      'fact-card',
      'fact-card',
      'chat-topics-card',
    ]);
    const topics = items.find(
      (i): i is Extract<ChatThreadItem, { kind: 'chat-topics-card' }> =>
        i.kind === 'chat-topics-card',
    );
    expect(topics?.merged).toBe(true);
    expect(topics?.facts.map((f) => f.factId)).toEqual(['f1', 'f2', 'f3']);
  });

  it('single Add keeps its own in-line topics card, not a merged one', () => {
    const base = stagedResult([['Lives in Hoorn']]);
    const items = itemsFor(
      withResolutions(base, {
        [factChoiceGroupId(0, ['Lives in Hoorn'])]: saved('Lives in Hoorn', 'f1'),
      }),
    );
    const topics = items.find(
      (i): i is Extract<ChatThreadItem, { kind: 'chat-topics-card' }> =>
        i.kind === 'chat-topics-card',
    );
    expect(topics?.merged).toBe(false);
  });

  it('never emits a topic-plan-card for a group-shaped result', () => {
    // The chat path uses chat-topics-card, which carries no Save/Discard and is
    // NOT counted by the topic-plan composer gate. A topic-plan-card here would
    // silently re-block the input on a card that no longer asks anything.
    const base = stagedResult(THREE);
    const items = itemsFor(
      withResolutions(base, {
        [factChoiceGroupId(0, ['Lives in Hoorn'])]: saved('Lives in Hoorn', 'f1'),
      }),
    );
    expect(kinds(items)).not.toContain('topic-plan-card');
  });

  it('does not double-render the legacy aggregate fact-card', () => {
    const base = stagedResult(THREE);
    const items = itemsFor(
      withResolutions(
        {
          ...base,
          // A fully-resolved blob also carries top-level savedFacts, which the
          // legacy reader would happily turn into a second, aggregate card.
          savedFacts: [{ id: 'f1', statement: 'Lives in Hoorn' }],
          factsSaved: 1,
        },
        { [factChoiceGroupId(0, ['Lives in Hoorn'])]: saved('Lives in Hoorn', 'f1') },
      ),
    );
    expect(kinds(items).filter((k) => k === 'fact-card')).toHaveLength(1);
  });

  it('LEGACY blob with no marker still renders the way it always did', () => {
    const items = itemsFor({
      success: true,
      factsSaved: 1,
      savedFacts: [{ id: 'f1', statement: 'Lives in Hoorn' }],
      conflicts: [],
    });
    expect(kinds(items)).toEqual(['message', 'fact-card', 'topic-plan-card']);
  });

  it('a stale group renders inert and gets no bulk row', () => {
    const result = stagedResult(THREE);
    const items = deriveThreadItems({
      live: [],
      history: [
        {
          id: MSG,
          conversationId: 'c-old',
          role: 'assistant',
          content: 'Got it.',
          createdAt: 1,
          toolCalls: [
            { id: 'tc-0', name: 'saveExtractedFacts', status: 'done', input: {}, result },
          ],
        } as never,
      ],
      introMessage: null,
      isStreaming: false,
      earlierConversationLabel: 'Earlier',
    });
    const cards = items.filter(
      (i): i is Extract<ChatThreadItem, { kind: 'fact-choice-card' }> =>
        i.kind === 'fact-choice-card',
    );
    expect(cards).toHaveLength(3);
    expect(cards.every((c) => c.stale)).toBe(true);
    // Revealing history must never re-block the composer, and a bulk row over
    // uncommittable cards would be a button that does nothing.
    expect(kinds(items)).not.toContain('fact-choice-bulk-row');
  });
});
