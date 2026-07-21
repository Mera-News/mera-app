// SwipeArticleCard render/tap tests. Reanimated + the open-suggestion hook +
// heavy UI primitives are stubbed (cards.test.tsx pattern) so the card renders
// under jest-expo without native modules.
/* eslint-disable @typescript-eslint/no-require-imports */

jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: any) => (opts?.count != null ? `${key}:${opts.count}` : key),
  }),
}));
jest.mock('react-native-reanimated', () => {
  const { View } = require('react-native');
  return {
    __esModule: true,
    default: { View: (p: any) => <View {...p} /> },
    useAnimatedStyle: () => ({}),
  };
});
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
jest.mock('@/components/ui/image', () => {
  const { View } = require('react-native');
  return { Image: (p: any) => <View {...p} /> };
});
jest.mock('@expo/vector-icons', () => {
  const { View } = require('react-native');
  return { MaterialIcons: (p: any) => <View {...p} /> };
});
jest.mock('@/components/custom/TranslatableDynamic', () => {
  const { Text } = require('react-native');
  return { __esModule: true, default: ({ text }: any) => <Text>{text}</Text> };
});
jest.mock('@/components/custom/RelevanceChip', () => {
  const { View } = require('react-native');
  return { __esModule: true, default: (p: any) => <View {...p} /> };
});
jest.mock('@/components/custom/ArticleMetaRow', () => {
  const { View } = require('react-native');
  const Stub = (p: any) => <View {...p} />;
  return { __esModule: true, default: Stub, ArticleMetaRow: Stub };
});

const mockOpen = jest.fn();
jest.mock('@/lib/hooks/use-open-suggestion', () => ({
  useOpenSuggestion: () => mockOpen,
}));

import { fireEvent, render } from '@testing-library/react-native';
import React from 'react';
import { ArticleSuggestionStatus } from '@/lib/database/article-suggestion-status';
import type { ForYouSuggestion } from '@/lib/stores/for-you-store';
import SwipeArticleCard from '../SwipeArticleCard';

const zero = { value: 0 } as any;

function sugg(over: Partial<ForYouSuggestion> = {}): ForYouSuggestion {
  return {
    _id: 'id1',
    articleId: 'art1',
    clusters: [],
    relevance: 0.7,
    reason: 'Matters to you',
    status: ArticleSuggestionStatus.Complete,
    country_code: 'US',
    language_code: 'en',
    publication_name: 'Pub',
    title_en: 'A tall headline',
    title_original: null,
    description_en: null,
    article_url: null,
    image_url: null,
    userTopicIds: [],
    createdAt: new Date().toISOString(),
    firstPubDate: new Date().toISOString(),
    rawScore: 0.5,
    eventType: null,
    headlineScope: null,
    matchedTopics: [],
    factIds: [],
    scoredAt: null,
    ...over,
  } as ForYouSuggestion;
}

beforeEach(() => mockOpen.mockClear());

describe('SwipeArticleCard', () => {
  it('renders title + reason', () => {
    const { getByText } = render(
      <SwipeArticleCard suggestion={sugg()} memberCount={1} likeOpacity={zero} nopeOpacity={zero} />,
    );
    expect(getByText('A tall headline')).toBeTruthy();
    expect(getByText('Matters to you')).toBeTruthy();
  });

  it('shows a "+N sources" chip only when the story collapses members', () => {
    const single = render(
      <SwipeArticleCard suggestion={sugg()} memberCount={1} likeOpacity={zero} nopeOpacity={zero} />,
    );
    expect(single.queryByText('feed.moreSources:1')).toBeNull();

    const grouped = render(
      <SwipeArticleCard suggestion={sugg()} memberCount={3} likeOpacity={zero} nopeOpacity={zero} />,
    );
    expect(grouped.getByText('feed.moreSources:2')).toBeTruthy();
  });

  it('opens the story on tap when interactive', () => {
    const s = sugg();
    const { getByText } = render(
      <SwipeArticleCard suggestion={s} memberCount={1} likeOpacity={zero} nopeOpacity={zero} interactive />,
    );
    fireEvent.press(getByText('A tall headline'));
    expect(mockOpen).toHaveBeenCalledWith(s);
  });

  it('does not open when non-interactive (a behind card)', () => {
    const { getByText } = render(
      <SwipeArticleCard suggestion={sugg()} memberCount={1} likeOpacity={zero} nopeOpacity={zero} interactive={false} />,
    );
    fireEvent.press(getByText('A tall headline'));
    expect(mockOpen).not.toHaveBeenCalled();
  });
});
