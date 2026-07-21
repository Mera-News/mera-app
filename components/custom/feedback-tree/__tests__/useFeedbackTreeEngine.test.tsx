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
  ],
  likeRoot: [
    { id: 'more_topic', labelKey: 'k.mt', labelDefault: 'More about this topic', leaf: {} },
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
    expect(result.current.currentChildren.map((n) => n.id)).toEqual(['wrong_topic', 'not_important']);

    // Remove the matched topic → the gated node drops out.
    rerender({ context: NO_TOPIC });
    expect(result.current.currentChildren.map((n) => n.id)).toEqual(['not_important']);
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
});
