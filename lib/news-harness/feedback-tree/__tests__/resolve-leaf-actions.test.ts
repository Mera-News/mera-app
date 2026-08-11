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

// The category kind carries one extra gate: 74% of the prod source catalogue
// (and 80% of SERVED articles) sits on the generic "news" family. A generic
// value mints NOTHING — not a keyword fallback. Keyword is a substring scan, so
// falling back to it on "News" attaches a filter to arbitrary stories that
// merely mention the word, which is worse than the exact-field filter being
// refused. Returning [] is also what lets `isInertActionLeaf` hide the option.
describe('resolveLeafActions — a generic category mints nothing', () => {
  const withKind: FeedbackTreeLeaf = {
    actions: [
      { type: 'add_suppression', pattern: 'from_context_category', kind: 'category', strength: 0.5 },
    ],
  };
  // The LIVE server tree still ships this_category with no `kind`, so the gate
  // must key off the placeholder, not the leaf's declaration.
  const withoutKind: FeedbackTreeLeaf = {
    actions: [{ type: 'add_suppression', pattern: 'from_context_category', strength: 0.5 }],
  };

  it.each(['News', 'news', 'general_news', 'News (French)', 'News (English, Pidgin)'])(
    'mints NO action for the generic category %p, with or without a declared kind',
    (category) => {
      expect(resolveLeafActions(withKind, ctx({ category }))).toEqual([]);
      expect(resolveLeafActions(withoutKind, ctx({ category }))).toEqual([]);
    },
  );

  it.each(['Sports', 'Tech', 'Business', 'Regional News: Kolkata'])(
    'still mints a STRUCTURED filter for the specific category %p',
    (category) => {
      expect(resolveLeafActions(withKind, ctx({ category }))).toEqual([
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

  it('a specific category with no declared kind still mints the keyword filter it always did', () => {
    expect(resolveLeafActions(withoutKind, ctx({ category: 'Sports' }))).toEqual([
      { action_type: ACTION_NAMES.ADD_SUPPRESSION, suppressionPattern: 'Sports', suppressionStrength: 0.5 },
    ]);
  });

  it('the PROVENANCE case still degrades to keyword rather than vanishing', () => {
    // Unprovable value: the leaf claims a category but reads the TITLE. The
    // value is not useless, just unverified — so it stays a keyword filter.
    const mismatched: FeedbackTreeLeaf = {
      actions: [
        { type: 'add_suppression', pattern: 'from_context_title', kind: 'category', strength: 0.5 },
      ],
    };
    expect(resolveLeafActions(mismatched, ctx({ articleTitle: 'A headline', category: 'News' }))).toEqual([
      { action_type: ACTION_NAMES.ADD_SUPPRESSION, suppressionPattern: 'A headline', suppressionStrength: 0.5 },
    ]);
    // A literal (author-authored) pattern is likewise keyword, never dropped.
    const literal: FeedbackTreeLeaf = {
      actions: [{ type: 'add_suppression', pattern: 'celebrity gossip', kind: 'category', strength: 0.5 }],
    };
    expect(resolveLeafActions(literal, ctx({ category: 'News' }))).toEqual([
      { action_type: ACTION_NAMES.ADD_SUPPRESSION, suppressionPattern: 'celebrity gossip', suppressionStrength: 0.5 },
    ]);
  });
});

// v5 — the two new placeholders behind "Show less of {{entity}}" / "Show less of
// {{place}}". Both must mint a STRUCTURED filter: a placeholder this module
// doesn't know is treated as a LITERAL pattern, which silently degrades to a
// normalized-substring keyword scan (over title + description + entities) —
// i.e. exactly the "looks applied, matches the wrong things" failure the
// placeholder→kind binding exists to prevent.
describe('resolveLeafActions — from_context_entity (v5)', () => {
  const leaf: FeedbackTreeLeaf = {
    actions: [
      { type: 'add_suppression', pattern: 'from_context_entity', kind: 'entity', strength: 0.5 },
    ],
  };

  it('mints an entity-KIND suppression whose value is the entity verbatim', () => {
    expect(resolveLeafActions(leaf, ctx({ entity: 'Reserve Bank of India' }))).toEqual([
      {
        action_type: ACTION_NAMES.ADD_SUPPRESSION,
        suppressionPattern: 'Reserve Bank of India',
        suppressionStrength: 0.5,
        suppressionKind: 'entity',
        suppressionValue: 'Reserve Bank of India',
      },
    ]);
  });

  it('is a REAL source, not a literal degrading to a keyword scan', () => {
    // The discriminator: an unregistered placeholder keeps its own name as the
    // pattern and carries NO kind. If `from_context_entity` is ever dropped
    // from SUPPRESSION_SOURCES, the assertion above starts producing this.
    const bogus: FeedbackTreeLeaf = {
      actions: [
        { type: 'add_suppression', pattern: 'from_context_entitiy', kind: 'entity', strength: 0.5 },
      ],
    };
    expect(resolveLeafActions(bogus, ctx({ entity: 'Reserve Bank of India' }))).toEqual([
      {
        action_type: ACTION_NAMES.ADD_SUPPRESSION,
        suppressionPattern: 'from_context_entitiy',
        suppressionStrength: 0.5,
      },
    ]);
  });

  it('resolves to nothing without an entity — so the leaf is hidden, not inert', () => {
    expect(resolveLeafActions(leaf, ctx())).toEqual([]);
    expect(resolveLeafActions(leaf, ctx({ entity: '   ' }))).toEqual([]);
  });

  it('stays SOFT: strength rides through unchanged and below the 0.8 hard bar', () => {
    const [action] = resolveLeafActions(leaf, ctx({ entity: 'Tesla' }));
    expect(action.suppressionStrength).toBe(0.5);
    expect(action.suppressionStrength!).toBeLessThan(0.8);
  });
});

describe('resolveLeafActions — from_context_place (v5)', () => {
  const leaf: FeedbackTreeLeaf = {
    actions: [
      { type: 'add_suppression', pattern: 'from_context_place', kind: 'place', strength: 0.5 },
    ],
  };

  it('reads placeValue (the tag field), NOT geoText (display prose)', () => {
    // The bug this shape exists to avoid: geoText resolves a supranational code
    // to "Middle East", and `place` matching compares normCountry to
    // normCountry — "MIDDLE EAST" vs the tag's "MIDDLE_EAST", forever unequal.
    expect(
      resolveLeafActions(leaf, ctx({ geoText: 'Middle East', placeValue: 'MIDDLE_EAST' })),
    ).toEqual([
      {
        action_type: ACTION_NAMES.ADD_SUPPRESSION,
        suppressionPattern: 'MIDDLE_EAST',
        suppressionStrength: 0.5,
        suppressionKind: 'place',
        suppressionValue: 'MIDDLE_EAST',
      },
    ]);
    // A geoText alone resolves NOTHING — the leaf is hidden rather than minting
    // a filter off prose.
    expect(resolveLeafActions(leaf, ctx({ geoText: 'Middle East' }))).toEqual([]);
  });

  it('carries a city verbatim', () => {
    expect(resolveLeafActions(leaf, ctx({ placeValue: 'amsterdam' }))).toEqual([
      {
        action_type: ACTION_NAMES.ADD_SUPPRESSION,
        suppressionPattern: 'amsterdam',
        suppressionStrength: 0.5,
        suppressionKind: 'place',
        suppressionValue: 'amsterdam',
      },
    ]);
  });

  it('leaves from_context_geo free of any kind — it is a negative-topic text', () => {
    const geoAsFilter: FeedbackTreeLeaf = {
      actions: [
        { type: 'add_suppression', pattern: 'from_context_geo', kind: 'place', strength: 0.5 },
      ],
    };
    // Not a registered suppression source ⇒ literal ⇒ keyword, and NOT a place
    // filter built from prose. Deliberate: see SUPPRESSION_SOURCES' comment.
    expect(resolveLeafActions(geoAsFilter, ctx({ geoText: 'Middle East' }))).toEqual([
      {
        action_type: ACTION_NAMES.ADD_SUPPRESSION,
        suppressionPattern: 'from_context_geo',
        suppressionStrength: 0.5,
      },
    ]);
  });
});
