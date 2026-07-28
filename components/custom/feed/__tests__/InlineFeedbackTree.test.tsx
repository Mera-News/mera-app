// InlineFeedbackTree tests — the Feed-tab inline tree. UI primitives are stubbed
// to plain RN views (cards.test.tsx pattern); the tree service + DB lookups are
// mocked so the tree renders without native deps.
/* eslint-disable @typescript-eslint/no-require-imports */

jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) =>
      (opts && (opts.defaultValue as string)) || key,
  }),
}));
jest.mock('@/components/ui/box', () => {
  const { View } = require('react-native');
  return { Box: (p: any) => <View {...p} /> };
});
jest.mock('@/components/ui/vstack', () => {
  const { View } = require('react-native');
  return { VStack: (p: any) => <View {...p} /> };
});
jest.mock('@/components/ui/hstack', () => {
  const { View } = require('react-native');
  return { HStack: (p: any) => <View {...p} /> };
});
jest.mock('@/components/ui/pressable', () => {
  const { Pressable } = require('react-native');
  return { Pressable };
});
jest.mock('@/components/ui/text', () => {
  const { Text } = require('react-native');
  return { Text };
});
jest.mock('@expo/vector-icons', () => {
  const { View } = require('react-native');
  return { MaterialIcons: (p: any) => <View {...p} /> };
});
jest.mock('@/lib/haptics', () => ({
  hapticLight: jest.fn(),
  hapticMedium: jest.fn(),
}));
jest.mock('@/lib/logger', () => ({ __esModule: true, default: { captureException: jest.fn() } }));
jest.mock('@/lib/database/services/publication-visit-service', () => ({
  getVisitCountForPublication: jest.fn(async () => 0),
}));
jest.mock('@/lib/database/services/article-suggestion-service', () => ({
  getSuggestionFeedbackContext: jest.fn(async () => ({ category: null })),
}));

const TREE = {
  version: 2,
  root: [
    {
      id: 'suggestion',
      labelKey: 'k.sug',
      labelDefault: 'Not a good suggestion',
      children: [
        { id: 'wrong_topic', labelKey: 'k.wt', labelDefault: 'Wrong topic', leaf: { actions: [] } },
        { id: 'something_else', labelKey: 'k.se', labelDefault: 'Something else', leaf: { openChat: true } },
      ],
    },
    {
      // Mirrors the production "paywall" node: a raw non-empty `children`
      // array whose only child is gated on `cluster_size_gte` — a condition
      // InlineFeedbackTree's local context never supplies (buildLocalContext
      // never sets `clusterSize`). It must render WITHOUT a chevron: tapping
      // it would otherwise descend into an empty "Thanks — noted." dead end.
      id: 'gated_branch',
      labelKey: 'k.gb',
      labelDefault: 'Gated branch',
      children: [
        {
          id: 'gated_leaf',
          labelKey: 'k.gl',
          labelDefault: 'Gated leaf',
          visibleIf: { cluster_size_gte: 2 },
          leaf: {},
        },
      ],
    },
  ],
  likeRoot: [
    {
      id: 'more_topic',
      labelKey: 'k.mt',
      labelDefault: 'More about this topic',
      children: [
        { id: 'a_lot_more', labelKey: 'k.alm', labelDefault: 'A lot more', leaf: { actions: [] } },
      ],
    },
  ],
};
jest.mock('@/lib/services/feedback-tree-service', () => ({
  getFeedbackTree: jest.fn(async () => TREE),
  refreshFeedbackTree: jest.fn(async () => {}),
}));

import { fireEvent, render, waitFor } from '@testing-library/react-native';
import React from 'react';
import type { ForYouSuggestion } from '@/lib/stores/for-you-store';
import InlineFeedbackTree from '../InlineFeedbackTree';

function makeSuggestion(): ForYouSuggestion {
  return {
    _id: 'sugg-1',
    articleId: 'art-1',
    clusters: [],
    relevance: 0.8,
    reason: '',
    status: 'complete' as ForYouSuggestion['status'],
    country_code: 'IN',
    language_code: 'en',
    publication_name: 'The Hindu',
    title_en: 'A story',
    title_original: null,
    description_en: null,
    article_url: null,
    image_url: null,
    userTopicIds: [],
    createdAt: '2026-07-20',
    firstPubDate: '2026-07-19',
    rawScore: null,
    eventType: null,
    headlineScope: null,
    matchedTopics: [{ topicId: 't1', text: 'cricket' }],
  };
}

describe('InlineFeedbackTree', () => {
  it('descending a branch records the path and reveals its children', async () => {
    const onTreePathChanged = jest.fn();
    const onInvokeMera = jest.fn();
    const onLeafCommitted = jest.fn();
    const { getByText } = render(
      <InlineFeedbackTree
        suggestion={makeSuggestion()}
        verdict="dislike"
        onTreePathChanged={onTreePathChanged}
        onInvokeMera={onInvokeMera}
        onLeafCommitted={onLeafCommitted}
      />,
    );

    const branch = await waitFor(() => getByText('Not a good suggestion'));
    fireEvent.press(branch);

    expect(onTreePathChanged).toHaveBeenCalledWith(
      expect.objectContaining({ articleId: 'art-1' }),
      'dislike',
      ['suggestion'],
    );
    // Children now visible.
    await waitFor(() => getByText('Wrong topic'));
    expect(onInvokeMera).not.toHaveBeenCalled();
    // A branch is not a terminal leaf — no auto-advance signal.
    expect(onLeafCommitted).not.toHaveBeenCalled();
  });

  it('tapping an openChat leaf escalates to Mera with the full path (no auto-advance)', async () => {
    const onTreePathChanged = jest.fn();
    const onInvokeMera = jest.fn();
    const onLeafCommitted = jest.fn();
    const { getByText } = render(
      <InlineFeedbackTree
        suggestion={makeSuggestion()}
        verdict="dislike"
        onTreePathChanged={onTreePathChanged}
        onInvokeMera={onInvokeMera}
        onLeafCommitted={onLeafCommitted}
      />,
    );

    fireEvent.press(await waitFor(() => getByText('Not a good suggestion')));
    fireEvent.press(await waitFor(() => getByText('Something else')));

    expect(onInvokeMera).toHaveBeenCalledWith(
      expect.objectContaining({ articleId: 'art-1' }),
      'dislike',
      ['suggestion', 'something_else'],
    );
    // openChat leaves hand off to Mera — they must NOT auto-advance the deck.
    expect(onLeafCommitted).not.toHaveBeenCalled();
  });

  it('tapping a terminal actions leaf records the path + fires onLeafCommitted (auto-advance)', async () => {
    const onTreePathChanged = jest.fn();
    const onInvokeMera = jest.fn();
    const onLeafCommitted = jest.fn();
    const { getByText } = render(
      <InlineFeedbackTree
        suggestion={makeSuggestion()}
        verdict="dislike"
        onTreePathChanged={onTreePathChanged}
        onInvokeMera={onInvokeMera}
        onLeafCommitted={onLeafCommitted}
      />,
    );

    fireEvent.press(await waitFor(() => getByText('Not a good suggestion')));
    fireEvent.press(await waitFor(() => getByText('Wrong topic')));

    expect(onInvokeMera).not.toHaveBeenCalled();
    expect(onTreePathChanged).toHaveBeenLastCalledWith(
      expect.objectContaining({ articleId: 'art-1' }),
      'dislike',
      ['suggestion', 'wrong_topic'],
    );
    expect(onLeafCommitted).toHaveBeenCalledWith(
      expect.objectContaining({ articleId: 'art-1' }),
      'dislike',
      ['suggestion', 'wrong_topic'],
    );
  });

  it('shows NO chevron on a branch whose only child is gated out (dead-end affordance)', async () => {
    const { getByText, UNSAFE_queryAllByProps } = render(
      <InlineFeedbackTree
        suggestion={makeSuggestion()}
        verdict="dislike"
        onTreePathChanged={jest.fn()}
        onInvokeMera={jest.fn()}
        onLeafCommitted={jest.fn()}
      />,
    );

    await waitFor(() => getByText('Not a good suggestion'));
    await waitFor(() => getByText('Gated branch'));

    // `gated_branch` has a raw `children` array (length 1), but its only
    // child is gated on cluster_size_gte — which this context never
    // satisfies. Only the REAL branch ('suggestion') gets a chevron; the
    // gated one must not, or tapping it would descend into an empty panel.
    // The mocked MaterialIcons (a bare prop-spreading View) matches once as
    // the composite fiber and once more for each RN View wrapper layer in
    // between — filter to the host "View" string-type fiber so this counts
    // rendered chevrons, not incidental fiber depth.
    const chevrons = UNSAFE_queryAllByProps({ name: 'arrow-forward-ios' }).filter(
      (node) => typeof node.type === 'string',
    );
    expect(chevrons).toHaveLength(1);
  });

  it('breadcrumb root renders the parent panel title, not a generic "All"', async () => {
    const dislike = render(
      <InlineFeedbackTree
        suggestion={makeSuggestion()}
        verdict="dislike"
        onTreePathChanged={jest.fn()}
        onInvokeMera={jest.fn()}
        onLeafCommitted={jest.fn()}
      />,
    );
    fireEvent.press(await waitFor(() => dislike.getByText('Not a good suggestion')));
    expect(await waitFor(() => dislike.getByText('Less like this'))).toBeTruthy();
    expect(dislike.queryByText('All')).toBeNull();

    const like = render(
      <InlineFeedbackTree
        suggestion={makeSuggestion()}
        verdict="like"
        onTreePathChanged={jest.fn()}
        onInvokeMera={jest.fn()}
        onLeafCommitted={jest.fn()}
      />,
    );
    fireEvent.press(await waitFor(() => like.getByText('More about this topic')));
    expect(await waitFor(() => like.getByText('More like this'))).toBeTruthy();
    expect(like.queryByText('All')).toBeNull();
  });

  it('an explicit rootLabel overrides the verdict-derived default (CardFeedbackSurface passes its own heading)', async () => {
    const { getByText, queryByText } = render(
      <InlineFeedbackTree
        suggestion={makeSuggestion()}
        verdict="dislike"
        rootLabel="Custom Heading"
        onTreePathChanged={jest.fn()}
        onInvokeMera={jest.fn()}
        onLeafCommitted={jest.fn()}
      />,
    );
    fireEvent.press(await waitFor(() => getByText('Not a good suggestion')));
    expect(await waitFor(() => getByText('Custom Heading'))).toBeTruthy();
    expect(queryByText('Less like this')).toBeNull();
  });
});
