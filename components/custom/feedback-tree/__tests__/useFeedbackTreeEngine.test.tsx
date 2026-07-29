// useFeedbackTreeEngine tests — root selection (like/dislike), evaluateCondition
// gating, and descent/backtrack/restore. The tree service is mocked; the pure
// evaluateCondition runs for real.

jest.mock('@/lib/services/feedback-tree-service', () => ({
  getFeedbackTree: jest.fn(async () => TREE),
  refreshFeedbackTree: jest.fn(async () => {}),
}));
jest.mock('@/lib/logger', () => ({
  __esModule: true,
  default: { captureException: jest.fn() },
}));

import { act, renderHook, waitFor } from '@testing-library/react-native';
import { getFeedbackTree } from '@/lib/services/feedback-tree-service';
import type { LocalFeedbackContext } from '@/lib/news-harness/feedback-tree';
import { useFeedbackTreeEngine, type FeedbackTreeEngine } from '../useFeedbackTreeEngine';

const TREE = {
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
const INERT_TREE = {
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

describe('useFeedbackTreeEngine', () => {
  it('selects the dislike root and gates nodes via evaluateCondition', async () => {
    const { result, rerender } = renderHook<
      FeedbackTreeEngine,
      { context: LocalFeedbackContext }
    >(({ context }) => useFeedbackTreeEngine({ active: true, root: 'dislike', context }), {
      initialProps: { context: WITH_TOPIC },
    });
    await waitFor(() => expect(result.current.tree).not.toBeNull());

    // has_matched_topics satisfied → both nodes visible.
    expect(result.current.currentChildren.map((n) => n.id)).toEqual([
      'wrong_topic',
      'not_important',
      'gated_branch',
    ]);

    // Remove the matched topic → the gated node drops out.
    rerender({ context: NO_TOPIC });
    expect(result.current.currentChildren.map((n) => n.id)).toEqual(['not_important', 'gated_branch']);
  });

  it('hasVisibleChildren is false when a branch\'s only child is gated out, true once satisfied', async () => {
    const { result, rerender } = renderHook<
      FeedbackTreeEngine,
      { context: LocalFeedbackContext }
    >(({ context }) => useFeedbackTreeEngine({ active: true, root: 'dislike', context }), {
      initialProps: { context: NO_TOPIC },
    });
    await waitFor(() => expect(result.current.tree).not.toBeNull());

    const gatedBranch = result.current.currentChildren.find((n) => n.id === 'gated_branch')!;
    // Raw `children` is non-empty, but the only child is gated out — terminal.
    expect(gatedBranch.children?.length).toBe(1);
    expect(result.current.hasVisibleChildren(gatedBranch)).toBe(false);

    rerender({ context: WITH_TOPIC });
    expect(result.current.hasVisibleChildren(gatedBranch)).toBe(true);
  });

  it('selects the like root when root is "like"', async () => {
    const { result } = renderHook(() =>
      useFeedbackTreeEngine({ active: true, root: 'like', context: WITH_TOPIC }),
    );
    await waitFor(() => expect(result.current.tree).not.toBeNull());
    expect(result.current.rootNodes.map((n) => n.id)).toEqual(['more_topic']);
  });

  it('descends into a branch and backtracks', async () => {
    const { result } = renderHook(() =>
      useFeedbackTreeEngine({ active: true, root: 'dislike', context: WITH_TOPIC }),
    );
    await waitFor(() => expect(result.current.tree).not.toBeNull());

    const branch = result.current.currentChildren.find((n) => n.id === 'not_important')!;
    act(() => result.current.descend(branch));
    expect(result.current.pathIds).toEqual(['not_important']);
    expect(result.current.currentChildren.map((n) => n.id)).toEqual(['this_cat']);

    act(() => result.current.backtrack());
    expect(result.current.pathIds).toEqual([]);
  });

  it('restorePath resumes the branch descent (trailing leaf id ignored)', async () => {
    const { result } = renderHook(() =>
      useFeedbackTreeEngine({ active: true, root: 'dislike', context: WITH_TOPIC }),
    );
    await waitFor(() => expect(result.current.tree).not.toBeNull());

    act(() => result.current.restorePath(['not_important', 'this_cat']));
    // Only the branch node is descended into; the leaf id stops the walk.
    expect(result.current.pathIds).toEqual(['not_important']);
  });

  // A leaf that declares persona actions but resolves to none under THIS
  // article applies nothing and shows no toast — the user learns that giving
  // feedback does nothing. Hiding it is tree-source-independent: it asks "would
  // this tap do anything", so it protects devices running the SERVER tree,
  // where a `visibleIf` gate added to the bundled snapshot doesn't exist.
  describe('inert action leaves', () => {
    beforeEach(() => {
      (getFeedbackTree as jest.Mock).mockResolvedValue(INERT_TREE);
    });
    afterAll(() => {
      (getFeedbackTree as jest.Mock).mockResolvedValue(TREE);
    });

    it('hides a leaf whose actions all resolve to nothing', async () => {
      const { result } = renderHook(() =>
        useFeedbackTreeEngine({ active: true, root: 'dislike', context: NO_TOPIC }),
      );
      await waitFor(() => expect(result.current.tree).not.toBeNull());
      expect(result.current.currentChildren.map((n) => n.id)).not.toContain('inert_leaf');
    });

    it('shows that same leaf once the context can resolve it', async () => {
      const { result } = renderHook(() =>
        useFeedbackTreeEngine({ active: true, root: 'dislike', context: WITH_CATEGORY }),
      );
      await waitFor(() => expect(result.current.tree).not.toBeNull());
      expect(result.current.currentChildren.map((n) => n.id)).toContain('inert_leaf');
    });

    it('keeps openChat/nudge/seenOnly leaves, which mutate nothing BY DESIGN', async () => {
      const { result } = renderHook(() =>
        useFeedbackTreeEngine({ active: true, root: 'dislike', context: NO_TOPIC }),
      );
      await waitFor(() => expect(result.current.tree).not.toBeNull());
      expect(result.current.currentChildren.map((n) => n.id)).toContain('chat_leaf');
    });

    it('hides a branch whose only surviving child is inert, so no chevron dead-ends', async () => {
      const { result } = renderHook(() =>
        useFeedbackTreeEngine({ active: true, root: 'dislike', context: NO_TOPIC }),
      );
      await waitFor(() => expect(result.current.tree).not.toBeNull());
      const branch = result.current.currentChildren.find((n) => n.id === 'inert_branch');
      expect(branch ? result.current.hasVisibleChildren(branch) : false).toBe(false);
    });
  });
});
