// The Sectioned view's section is ONE button that opens the fact's list: the preview stories
// are plain grouped rows (no menu, no per-row press), and a stacked edge shows when more
// stories wait behind the three. Native edges (router, reanimated, scroll plumbing) are faked.
import { fireEvent, render } from '@testing-library/react-native';
import React from 'react';
import DashboardSectionsFeed from '@/components/custom/for-you/DashboardSectionsFeed';
import type { FactRow } from '@/lib/stores/fact-rows-selector';
import { initI18nEn } from '@/test/helpers';

const mockPush = jest.fn();
jest.mock('expo-router', () => ({ router: { push: (a: unknown) => mockPush(a) } }));

jest.mock('react-native-reanimated', () => {
  const { View, FlatList } = require('react-native');
  const { useRef } = require('react');
  return {
    __esModule: true,
    default: { View, FlatList, createAnimatedComponent: (C: unknown) => C },
    Easing: require('react-native').Easing,
    useSharedValue: (v: unknown) => useRef({ value: v }).current,
    useAnimatedStyle: (fn: () => unknown) => fn(),
    useAnimatedScrollHandler: () => () => {},
    useComposedEventHandler: () => () => {},
    useReducedMotion: () => false,
    withTiming: (v: unknown) => v,
    runOnJS: (f: unknown) => f,
  };
});
jest.mock('@/components/custom/nav/page-scroll', () => ({ usePageScrollTarget: () => {} }));
jest.mock('@/components/custom/feed/use-anchor-past-header', () => ({
  useAnchorPastHeader: () => ({ pastHeader: false, onListHeaderLayout: () => {}, anchorHandler: () => {} }),
}));
jest.mock('@/lib/navigation/tab-bar', () => ({ useListEndClearance: () => 0 }));
jest.mock('@/components/custom/TranslatableDynamic', () => {
  const { Text } = require('react-native');
  return { __esModule: true, default: ({ text }: { text: string }) => <Text>{text}</Text> };
});

beforeAll(initI18nEn);
beforeEach(() => mockPush.mockClear());

const group = (id: string) =>
  ({
    data: {
      _id: id,
      articleId: id,
      title_en: `Headline ${id}`,
      publication_name: 'Harbour Daily',
      language_code: 'en',
      relevance: 0.5,
    },
    members: [],
    rawScore: null,
    bucket: 'high',
    pubDateMs: 0,
  }) as never;

const row = (factId: string, n: number) =>
  ({ factId, statement: `Fact ${factId}`, groups: Array.from({ length: n }, (_, i) => group(`${factId}-${i}`)) }) as unknown as FactRow;

const renderFeed = (rows: FactRow[]) =>
  render(
    <DashboardSectionsFeed
      rows={rows}
      openedIds={new Set()}
      sortSnapshot={{ cardStates: {}, openedArticleIds: new Set() }}
      onPressSuggestion={() => {}}
      scrollHandler={(() => {}) as never}
      headerHeight={0}
    />,
  );

describe('Sectioned view section', () => {
  it('is one button labelled with the title and count that opens the fact list', async () => {
    const { getAllByRole, getByTestId } = await renderFeed([row('f1', 5)]);
    expect(getAllByRole('button')).toHaveLength(1);
    const open = getByTestId('section-open-f1');
    expect(open.props.accessibilityLabel).toBe('Fact f1, 5 stories');
    fireEvent.press(open);
    expect(mockPush).toHaveBeenCalledWith({
      pathname: '/logged-in/app_container/feed/interest',
      params: { factId: 'f1', statement: 'Fact f1' },
    });
  });

  it('draws preview rows with no menu button or per-row press', async () => {
    // The rows are hidden from VoiceOver on purpose, so query past that.
    const all = { includeHiddenElements: true };
    const { queryByTestId, queryAllByTestId } = await renderFeed([row('f1', 5)]);
    expect(queryAllByTestId('section-preview-row', all)).toHaveLength(3);
    expect(queryByTestId('compact-card-more', all)).toBeNull();
    expect(queryByTestId('card-f1-0', all)).toBeNull();
  });

  it('draws the stacked edge only when more stories wait than the preview shows', async () => {
    const many = await renderFeed([row('f1', 4)]);
    expect(many.getByTestId('section-stack-edge', { includeHiddenElements: true })).toBeTruthy();
    const few = await renderFeed([row('f2', 3)]);
    expect(few.queryByTestId('section-stack-edge', { includeHiddenElements: true })).toBeNull();
  });
});
