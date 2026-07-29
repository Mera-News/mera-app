import { resolveLeafActions } from '../resolve-leaf-actions';
import { ACTION_NAMES } from '../../persona-management/action-names';
import type {
  FeedbackTreeAbstractAction,
  FeedbackTreeLeaf,
  LocalFeedbackContext,
} from '../types';

const ctx = (over: Partial<LocalFeedbackContext> = {}): LocalFeedbackContext => ({ ...over });

describe('resolveLeafActions', () => {
  it('no actions → empty', () => {
    expect(resolveLeafActions(undefined, ctx())).toEqual([]);
    expect(resolveLeafActions({}, ctx())).toEqual([]);
    expect(resolveLeafActions({ nudge: 'subscribe' }, ctx())).toEqual([]);
  });

  it('set_publication_pref uses the publication NAME as target', () => {
    const leaf: FeedbackTreeLeaf = { actions: [{ type: 'set_publication_pref', value: 'mute' }] };
    expect(resolveLeafActions(leaf, ctx({ publicationName: 'The Daily' }))).toEqual([
      { action_type: ACTION_NAMES.SET_PUBLICATION_PREF, publicationId: 'The Daily', publicationPref: 'mute' },
    ]);
  });

  it('set_publication_pref skips without a publication name or with a bad value', () => {
    const leaf: FeedbackTreeLeaf = { actions: [{ type: 'set_publication_pref', value: 'deprioritize' }] };
    expect(resolveLeafActions(leaf, ctx())).toEqual([]);
    const bad: FeedbackTreeLeaf = { actions: [{ type: 'set_publication_pref', value: 'nonsense' }] };
    expect(resolveLeafActions(bad, ctx({ publicationName: 'X' }))).toEqual([]);
  });

  it('add_negative_topic fills from_context_geo', () => {
    const leaf: FeedbackTreeLeaf = {
      actions: [{ type: 'add_negative_topic', text: 'from_context_geo', weight: -0.6 }],
    };
    expect(resolveLeafActions(leaf, ctx({ geoText: 'Mumbai' }))).toEqual([
      { action_type: ACTION_NAMES.ADD_NEGATIVE_TOPIC, topicText: 'Mumbai', weight: -0.6 },
    ]);
    // missing geo → skipped
    expect(resolveLeafActions(leaf, ctx())).toEqual([]);
  });

  it('set_topic_weight (matched) yields one action per matched topic id', () => {
    const leaf: FeedbackTreeLeaf = {
      actions: [{ type: 'set_topic_weight', topics: 'matched', delta: -0.15 }],
    };
    const out = resolveLeafActions(
      leaf,
      ctx({ matchedTopics: [{ topicId: 't1', text: 'a' }, { topicId: null, text: 'b' }, { topicId: 't2', text: 'c' }] }),
    );
    expect(out).toEqual([
      { action_type: ACTION_NAMES.SET_TOPIC_WEIGHT, topicId: 't1', delta: -0.15 },
      { action_type: ACTION_NAMES.SET_TOPIC_WEIGHT, topicId: 't2', delta: -0.15 },
    ]);
  });

  it('set_topic_weight (from_selection) prefers explicit selection, falls back to matched', () => {
    const leaf: FeedbackTreeLeaf = {
      actions: [{ type: 'set_topic_weight', topics: 'from_selection', delta: -0.2 }],
    };
    const sel = resolveLeafActions(
      leaf,
      ctx({ selectedTopicIds: ['s1'], matchedTopics: [{ topicId: 't1', text: 'a' }] }),
    );
    expect(sel).toEqual([{ action_type: ACTION_NAMES.SET_TOPIC_WEIGHT, topicId: 's1', delta: -0.2 }]);

    const fallback = resolveLeafActions(leaf, ctx({ matchedTopics: [{ topicId: 't1', text: 'a' }] }));
    expect(fallback).toEqual([{ action_type: ACTION_NAMES.SET_TOPIC_WEIGHT, topicId: 't1', delta: -0.2 }]);
  });

  it('add_suppression fills from_context_title', () => {
    const leaf: FeedbackTreeLeaf = {
      actions: [{ type: 'add_suppression', pattern: 'from_context_title', strength: 0.5 }],
    };
    expect(resolveLeafActions(leaf, ctx({ articleTitle: '  Crypto crashes again  ' }))).toEqual([
      { action_type: ACTION_NAMES.ADD_SUPPRESSION, suppressionPattern: 'Crypto crashes again', suppressionStrength: 0.5 },
    ]);
    expect(resolveLeafActions(leaf, ctx())).toEqual([]);
  });

  it('add_suppression fills from_context_category', () => {
    const leaf: FeedbackTreeLeaf = {
      actions: [{ type: 'add_suppression', pattern: 'from_context_category', strength: 0.5 }],
    };
    expect(resolveLeafActions(leaf, ctx({ category: '  Politics  ' }))).toEqual([
      { action_type: ACTION_NAMES.ADD_SUPPRESSION, suppressionPattern: 'Politics', suppressionStrength: 0.5 },
    ]);
    expect(resolveLeafActions(leaf, ctx())).toEqual([]);
  });

  it('add_suppression fills from_context_eventType', () => {
    const leaf: FeedbackTreeLeaf = {
      actions: [{ type: 'add_suppression', pattern: 'from_context_eventType', strength: 0.5 }],
    };
    expect(resolveLeafActions(leaf, ctx({ eventType: '  Earnings call  ' }))).toEqual([
      { action_type: ACTION_NAMES.ADD_SUPPRESSION, suppressionPattern: 'Earnings call', suppressionStrength: 0.5 },
    ]);
    expect(resolveLeafActions(leaf, ctx())).toEqual([]);
  });

  it('add_negative_topic supports a positive weight (like-tree place-boost)', () => {
    const leaf: FeedbackTreeLeaf = {
      actions: [{ type: 'add_negative_topic', text: 'from_context_geo', weight: 0.6 }],
    };
    expect(resolveLeafActions(leaf, ctx({ geoText: 'Mumbai' }))).toEqual([
      { action_type: ACTION_NAMES.ADD_NEGATIVE_TOPIC, topicText: 'Mumbai', weight: 0.6 },
    ]);
  });

  it('unknown action type is ignored (forward-compat)', () => {
    const leaf: FeedbackTreeLeaf = {
      actions: [{ type: 'teleport_user' }, { type: 'set_publication_pref', value: 'mute' }],
    };
    expect(resolveLeafActions(leaf, ctx({ publicationName: 'X' }))).toEqual([
      { action_type: ACTION_NAMES.SET_PUBLICATION_PREF, publicationId: 'X', publicationPref: 'mute' },
    ]);
  });
});

// D9/D10 — a STRUCTURED filter matches by exact normalized equality on ONE
// article field, so its value must be that field verbatim. The kind is
// therefore tied to the context PLACEHOLDER, never trusted from the leaf alone:
// a value we can't guarantee came from the article silently matches nothing.
describe('resolveLeafActions — structured suppression kinds', () => {
  it('from_context_category + kind:category → an exact category filter', () => {
    const leaf: FeedbackTreeLeaf = {
      actions: [
        { type: 'add_suppression', pattern: 'from_context_category', kind: 'category', strength: 0.5 },
      ],
    };
    expect(resolveLeafActions(leaf, ctx({ category: '  Politics  ' }))).toEqual([
      {
        action_type: ACTION_NAMES.ADD_SUPPRESSION,
        suppressionPattern: 'Politics',
        suppressionStrength: 0.5,
        suppressionKind: 'category',
        suppressionValue: 'Politics',
      },
    ]);
  });

  it('from_context_eventType + kind:event_type → an exact event-type filter', () => {
    const leaf: FeedbackTreeLeaf = {
      actions: [
        { type: 'add_suppression', pattern: 'from_context_eventType', kind: 'event_type', strength: 0.5 },
      ],
    };
    expect(resolveLeafActions(leaf, ctx({ eventType: 'Earnings call' }))).toEqual([
      {
        action_type: ACTION_NAMES.ADD_SUPPRESSION,
        suppressionPattern: 'Earnings call',
        suppressionStrength: 0.5,
        suppressionKind: 'event_type',
        suppressionValue: 'Earnings call',
      },
    ]);
  });

  it('degrades to a keyword filter for a literal pattern, a mismatched kind, or an unknown kind', () => {
    const cases: FeedbackTreeAbstractAction[] = [
      // The author's own words — nothing guarantees an article field holds them.
      { type: 'add_suppression', pattern: 'celebrity gossip', kind: 'category', strength: 0.5 },
      // The placeholder reads the TITLE; a title is not the category field.
      { type: 'add_suppression', pattern: 'from_context_title', kind: 'category', strength: 0.5 },
      // Right field, wrong kind claimed.
      { type: 'add_suppression', pattern: 'from_context_category', kind: 'entity', strength: 0.5 },
      // Not a SUPPRESSION_KINDS member at all.
      { type: 'add_suppression', pattern: 'from_context_category', kind: 'sentiment', strength: 0.5 },
    ];
    for (const action of cases) {
      const [resolved] = resolveLeafActions(
        { actions: [action] },
        ctx({ category: 'Politics', articleTitle: 'A headline' }),
      ) as { suppressionKind?: string; suppressionValue?: string }[];
      expect(resolved.suppressionKind).toBeUndefined();
      expect(resolved.suppressionValue).toBeUndefined();
    }
  });

  it('a placeholder with no kind keeps the pre-existing keyword behaviour', () => {
    const leaf: FeedbackTreeLeaf = {
      actions: [{ type: 'add_suppression', pattern: 'from_context_category', strength: 0.5 }],
    };
    expect(resolveLeafActions(leaf, ctx({ category: 'Politics' }))).toEqual([
      { action_type: ACTION_NAMES.ADD_SUPPRESSION, suppressionPattern: 'Politics', suppressionStrength: 0.5 },
    ]);
  });
});

// The category kind carries one extra gate: ~74% of the prod source catalogue
// sits on the generic "news" family, where an exact match is most of the feed
// rather than "this category". Those degrade to a keyword filter — silently,
// and identically to the pre-D10 behaviour.
describe('resolveLeafActions — generic categories stay keyword', () => {
  const leaf: FeedbackTreeLeaf = {
    actions: [
      { type: 'add_suppression', pattern: 'from_context_category', kind: 'category', strength: 0.5 },
    ],
  };

  it.each(['News', 'general_news', 'News (French)'])(
    'mints a KEYWORD filter for the generic category %p',
    (category) => {
      expect(resolveLeafActions(leaf, ctx({ category }))).toEqual([
        {
          action_type: ACTION_NAMES.ADD_SUPPRESSION,
          suppressionPattern: category,
          suppressionStrength: 0.5,
        },
      ]);
    },
  );

  it.each(['Sports', 'Tech', 'Business'])(
    'still mints a STRUCTURED filter for the specific category %p',
    (category) => {
      expect(resolveLeafActions(leaf, ctx({ category }))).toEqual([
        {
          action_type: ACTION_NAMES.ADD_SUPPRESSION,
          suppressionPattern: category,
          suppressionStrength: 0.5,
          suppressionKind: 'category',
          suppressionValue: category,
        },
      ]);
    },
  );
});
