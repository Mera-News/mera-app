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
  ],
  likeRoot: [],
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
});
