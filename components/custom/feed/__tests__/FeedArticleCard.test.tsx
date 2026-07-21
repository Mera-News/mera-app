// FeedArticleCard render/tap tests. Heavy UI primitives + the save service +
// CardActionBar are stubbed (cards.test.tsx pattern) so the card renders under
// jest-expo without native modules.
/* eslint-disable @typescript-eslint/no-require-imports */

jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: any) => (opts?.count != null ? `${key}:${opts.count}` : key),
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
jest.mock('../CardActionBar', () => {
  const { View } = require('react-native');
  return { __esModule: true, default: (p: any) => <View testID="action-bar" {...p} /> };
});
jest.mock('@/lib/haptics', () => ({ hapticLight: jest.fn(), hapticSuccess: jest.fn() }));
jest.mock('@/lib/database/services/saved-article-suggestion-service', () => ({
  saveSuggestion: jest.fn(),
  deleteSavedSuggestion: jest.fn(),
  isSuggestionSaved: jest.fn(async () => false),
}));

import { fireEvent, render } from '@testing-library/react-native';
import React from 'react';
import { ArticleSuggestionStatus } from '@/lib/database/article-suggestion-status';
import type { FeedListItem } from '@/lib/stores/feed-list-selector';
import type { ForYouSuggestion } from '@/lib/stores/for-you-store';
import FeedArticleCard from '../FeedArticleCard';

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

function makeItem(over: Partial<FeedListItem> = {}): FeedListItem {
  return {
    id: 'art1',
    suggestion: sugg(),
    memberCount: 1,
    breaking: false,
    score: 0.9,
    ...over,
  };
}

/** Walk up from a node to find the nearest resolved `opacity` style. */
function opacityOf(node: any): number | undefined {
  let n: any = node;
  while (n) {
    const st = n.props?.style;
    const flat = Array.isArray(st) ? Object.assign({}, ...st) : st;
    if (flat && typeof flat.opacity === 'number') return flat.opacity;
    n = n.parent;
  }
  return undefined;
}

describe('FeedArticleCard', () => {
  it('renders the title + reason', () => {
    const { getByText } = render(
      <FeedArticleCard
        item={makeItem()}
        verdict={null}
        onPress={jest.fn()}
        onVerdict={jest.fn()}
        onAskMera={jest.fn()}
      />,
    );
    expect(getByText('A tall headline')).toBeTruthy();
    expect(getByText('Matters to you')).toBeTruthy();
  });

  it('opens the story on body press with the suggestion', () => {
    const onPress = jest.fn();
    const it = makeItem();
    const { getByText } = render(
      <FeedArticleCard
        item={it}
        verdict={null}
        onPress={onPress}
        onVerdict={jest.fn()}
        onAskMera={jest.fn()}
      />,
    );
    fireEvent.press(getByText('A tall headline'));
    expect(onPress).toHaveBeenCalledWith(it.suggestion);
  });

  it('dims the body when verdicted (opacity 0.7)', () => {
    const { getByText } = render(
      <FeedArticleCard
        item={makeItem()}
        verdict="like"
        onPress={jest.fn()}
        onVerdict={jest.fn()}
        onAskMera={jest.fn()}
      />,
    );
    expect(opacityOf(getByText('A tall headline'))).toBe(0.7);
  });

  it('keeps the body at full opacity when undecided', () => {
    const { getByText } = render(
      <FeedArticleCard
        item={makeItem()}
        verdict={null}
        onPress={jest.fn()}
        onVerdict={jest.fn()}
        onAskMera={jest.fn()}
      />,
    );
    expect(opacityOf(getByText('A tall headline'))).toBe(1);
  });
});
