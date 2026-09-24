// resolveTreeLevel: root selection (like/dislike), evaluateCondition gating,
// the inert-leaf and dead-branch rules, and branch descent by path. Pure: the
// pure evaluateCondition / resolveLeafActions run for real.

import type { FeedbackTree, LocalFeedbackContext } from '@/lib/news-harness/feedback-tree';
import { resolveTreeLevel } from '../useFeedbackTreeEngine';

const TREE: FeedbackTree = {
  version: 2,
  root: [
    {
      id: 'wrong_topic',
      labelKey: 'k.wt',
      labelDefault: 'Wrong topic',
      visibleIf: { has_matched_topics: true },
      leaf: { actions: [] },
    },
    {
      id: 'not_important',
      labelKey: 'k.ni',
      labelDefault: 'Not important',
      children: [{ id: 'this_cat', labelKey: 'k.tc', labelDefault: 'This category', leaf: {} }],
    },
    {
      // A branch whose ONLY child is itself gated — a raw non-empty
      // `children` array that resolves to zero visible children unless the
      // context satisfies the child's `visibleIf`. This is the "chevron
      // dead-ends" case hasVisibleChildren exists to catch.
      id: 'gated_branch',
      labelKey: 'k.gb',
      labelDefault: 'Gated branch',
      children: [
        {
          id: 'gated_leaf',
          labelKey: 'k.gl',
          labelDefault: 'Gated leaf',
          visibleIf: { has_matched_topics: true },
          leaf: {},
        },
      ],
    },
  ],
  likeRoot: [
    { id: 'more_topic', labelKey: 'k.mt', labelDefault: 'More about this topic', leaf: {} },
  ],
};

const WITH_CATEGORY: LocalFeedbackContext = { matchedTopics: [], category: 'Sports' };

// A SEPARATE tree for the inert-leaf cases, so the exhaustive root-id
// assertions above keep asserting over the fixture they were written for.
const INERT_TREE: FeedbackTree = {
  version: 2,
  root: [
    {
      // Declares a real action whose value comes from a context field. With no
      // `category` on the article it resolves to NOTHING — tapping it would
      // apply nothing and show no toast. This is `this_kind_of_event` in prod,
      // where event_type is null on every article.
      id: 'inert_leaf',
      labelKey: 'k.il',
      labelDefault: 'This category',
      leaf: { actions: [{ type: 'add_suppression', pattern: 'from_context_category' }] },
    },
    {
      // Same shape, but escalates to chat instead of mutating. Legitimately
      // resolves to zero actions and MUST survive.
      id: 'chat_leaf',
      labelKey: 'k.cl',
      labelDefault: 'Tell Mera',
      leaf: { openChat: true, actions: [{ type: 'add_suppression', pattern: 'from_context_category' }] },
    },
    {
      // QA's `paywall`: a BRANCH with no leaf whose children are all gated off.
      // isInertActionLeaf can't see it (no leaf), so before the fix it rendered
      // with a chevron and dead-ended.
      id: 'dead_branch',
      labelKey: 'k.db',
      labelDefault: "It's paywalled",
      children: [
        {
          id: 'gated_a',
          labelKey: 'k.ga',
          labelDefault: 'Subscribe',
          visibleIf: { has_matched_topics: true },
          leaf: { nudge: 'subscribe' },
        },
      ],
    },
    {
      // A branch whose only child is the inert leaf: the chevron must not
      // render, or it descends into an empty level.
      id: 'inert_branch',
      labelKey: 'k.ib',
      labelDefault: 'Inert branch',
      children: [
        {
          id: 'inert_child',
          labelKey: 'k.ic',
          labelDefault: 'This category',
          leaf: { actions: [{ type: 'add_suppression', pattern: 'from_context_category' }] },
        },
      ],
    },
  ],
};

const WITH_TOPIC: LocalFeedbackContext = { matchedTopics: [{ topicId: 't1', text: 'cricket' }] };
const NO_TOPIC: LocalFeedbackContext = { matchedTopics: [] };

const ids = (tree: FeedbackTree, root: 'like' | 'dislike', path: string[], ctx: LocalFeedbackContext) =>
  resolveTreeLevel(tree, root, path, ctx).nodes.map((n) => n.id);

describe('resolveTreeLevel', () => {
  it('selects the dislike root and gates nodes via evaluateCondition', () => {
    expect(ids(TREE, 'dislike', [], WITH_TOPIC)).toEqual(['wrong_topic', 'not_important', 'gated_branch']);
    // A branch with no visible children is hidden outright (not-interested P4i):
    // a row that does nothing when tapped is worse than an absent one.
    expect(ids(TREE, 'dislike', [], NO_TOPIC)).toEqual(['not_important']);
  });

  it('a branch whose only child is gated out returns once satisfied, with visible children', () => {
    expect(ids(TREE, 'dislike', [], NO_TOPIC)).not.toContain('gated_branch');
    const level = resolveTreeLevel(TREE, 'dislike', [], WITH_TOPIC);
    const gated = level.nodes.find((n) => n.id === 'gated_branch')!;
    expect(level.hasVisibleChildren(gated)).toBe(true);
  });

  it('selects the like root', () => {
    expect(ids(TREE, 'like', [], WITH_TOPIC)).toEqual(['more_topic']);
  });

  it('descends along the branch path, and a trailing leaf id stops the walk', () => {
    expect(ids(TREE, 'dislike', ['not_important'], WITH_TOPIC)).toEqual(['this_cat']);
    expect(ids(TREE, 'dislike', ['not_important', 'this_cat'], WITH_TOPIC)).toEqual(['this_cat']);
  });

  it('finds a node anywhere under the root', () => {
    expect(resolveTreeLevel(TREE, 'dislike', [], WITH_TOPIC).findNode('this_cat')?.labelDefault).toBe('This category');
  });

  // A leaf that declares persona actions but resolves to none under THIS
  // article applies nothing and shows no toast. Hiding it asks "would this tap
  // do anything", so it protects devices running the SERVER tree too.
  describe('inert action leaves', () => {
    it('hides a leaf whose actions all resolve to nothing', () => {
      expect(ids(INERT_TREE, 'dislike', [], NO_TOPIC)).not.toContain('inert_leaf');
    });

    it('shows that same leaf once the context can resolve it', () => {
      expect(ids(INERT_TREE, 'dislike', [], WITH_CATEGORY)).toContain('inert_leaf');
    });

    it('keeps openChat/nudge/seenOnly leaves, which mutate nothing BY DESIGN', () => {
      expect(ids(INERT_TREE, 'dislike', [], NO_TOPIC)).toContain('chat_leaf');
    });

    it('hides a BRANCH whose children all gate out (QA: the paywall dead end)', () => {
      expect(ids(INERT_TREE, 'dislike', [], NO_TOPIC)).not.toContain('dead_branch');
    });

    it('shows that branch again once a child can pass its gate', () => {
      expect(ids(INERT_TREE, 'dislike', [], WITH_TOPIC)).toContain('dead_branch');
    });

    it('hides a branch whose only surviving child is inert, so no chevron dead-ends', () => {
      const level = resolveTreeLevel(INERT_TREE, 'dislike', [], NO_TOPIC);
      const branch = level.nodes.find((n) => n.id === 'inert_branch');
      expect(branch ? level.hasVisibleChildren(branch) : false).toBe(false);
    });
  });
});

describe('resolveTreeLevel: the flat dislike root (shipped tree)', () => {
    const { BUNDLED_FEEDBACK_TREE } = require('@/lib/services/feedback-tree-snapshot');
    const CTX: LocalFeedbackContext = { matchedTopics: [{ topicId: 't1', text: 'cricket' }] };

    it('promotes the one-tap "not_important" leaf to the head of the dislike root', () => {
        expect(ids(BUNDLED_FEEDBACK_TREE, 'dislike', [], CTX)).toEqual(['not_important', 'publication_issue', 'suggestion']);
    });

    it('drops it from its own branch, so it shows once', () => {
        expect(ids(BUNDLED_FEEDBACK_TREE, 'dislike', ['suggestion'], CTX)).not.toContain('not_important');
    });

    it('leaves the like root alone', () => {
        expect(ids(BUNDLED_FEEDBACK_TREE, 'like', [], CTX)[0]).toBe('more_about_topic');
    });
});

// PROD serves v4 today: the flat root must not depend on the tree's shape.
describe('resolveTreeLevel: the flat dislike root on prod v4', () => {
    const { FEEDBACK_TREE_V4 } = require('./fixtures/feedback-tree-v4');
    // A publication, or the publication branches' actions resolve to nothing
    // and the dead-branch rule hides them (correct, and not what this pins).
    const CTX: LocalFeedbackContext = { matchedTopics: [{ topicId: 't1', text: 'cricket' }], publicationName: 'NOS' };

    it('promotes "not_important" to the head, then the four v4 branches', () => {
        expect(ids(FEEDBACK_TREE_V4, 'dislike', [], CTX)).toEqual([
            'not_important',
            'publication_website',
            'publication_content',
            'suggestion',
            'not_important_to_me',
        ]);
    });

    it('drops it from the branch that holds it, found by id', () => {
        expect(ids(FEEDBACK_TREE_V4, 'dislike', ['suggestion'], CTX)).toEqual(['not_related', 'seen_already', 'too_many']);
    });
});

