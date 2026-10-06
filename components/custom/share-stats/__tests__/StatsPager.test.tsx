/* eslint-disable @typescript-eslint/no-require-imports */
// The Library's Stats page: the pager reports its edges to the page swipe,
// the capture host exists only while the page is active, an arrival lands on
// the card it names, and before any card exists the page states the real rule.
jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string) => k, i18n: { language: 'en' } }),
}));
let mockStats: unknown = null;
jest.mock('@/lib/stats/reading-stats-source', () => ({
  loadReadingStats: () => Promise.resolve(mockStats),
}));
jest.mock('@/lib/logger', () => ({ __esModule: true, default: { captureException: jest.fn() } }));
jest.mock('@/components/custom/share-stats/capture-and-share', () => ({ captureAndShare: jest.fn() }));
jest.mock('@/components/custom/share-stats/ShareStatsCard', () => {
  const ReactLib = require('react');
  const { View } = require('react-native');
  return {
    __esModule: true,
    default: ReactLib.forwardRef((p: any, ref: any) => <View ref={ref} testID={`card-${p.card}`} />),
    fitCardToPage: ({ width, height }: { width: number; height: number }) => ({
      width: Math.min(width, height * 0.76),
      height: Math.min(height, width / 0.76),
    }),
    hostSizeForScale: () => ({ width: 360, height: 640 }),
  };
});
jest.mock('@/components/custom/analytics/ShareCardPill', () => {
  const { Pressable } = require('react-native');
  return { __esModule: true, default: (p: any) => <Pressable testID={p.testID} onPress={p.onPress} accessibilityLabel={p.label} /> };
});
const mockSetEdge = jest.fn();
const mockBlockerRef = { current: null as unknown };
let mockBlocker: unknown = { ref: mockBlockerRef, setEdge: (e: unknown) => mockSetEdge(e) };
jest.mock('@/components/custom/nav/swipe-blocker', () => ({ useSwipeTabsBlocker: () => mockBlocker }));
jest.mock('react-native-gesture-handler', () => {
  const ReactLib = require('react');
  const { View } = require('react-native');
  return { ScrollView: ReactLib.forwardRef((p: any, ref: any) => <View ref={ref} {...p} />) };
});
jest.mock('react-native-reanimated', () => {
  const { View } = require('react-native');
  return { __esModule: true, default: { ScrollView: (p: any) => <View {...p} /> } };
});
jest.mock('@/components/custom/for-you/ForYouEmptyState', () => {
  const { Text } = require('react-native');
  return { __esModule: true, default: (p: any) => <Text testID={p.testID}>{`${p.title}|${p.body}`}</Text> };
});
jest.mock('@/components/ui/hstack', () => {
  const { View } = require('react-native');
  return { HStack: (p: any) => <View {...p} /> };
});
jest.mock('@/components/ui/text', () => {
  const { Text } = require('react-native');
  return { Text: (p: any) => <Text {...p} /> };
});
jest.mock('@/components/ui/spinner', () => ({ Spinner: () => null }));
jest.mock('@/components/ui/switch', () => {
  const { Pressable } = require('react-native');
  return { Switch: (p: any) => <Pressable testID={p.testID} onPress={() => p.onToggle(!p.value)} /> };
});

import { act, fireEvent, render, screen } from '@testing-library/react-native';
import React from 'react';
import { StyleSheet } from 'react-native';
import { emptyReadingStats } from '@/lib/stats/reading-stats';
import StatsPager, { pagerEdges } from '../StatsPager';

const W = 400;
const withCards = () => ({
  ...emptyReadingStats(),
  // reach and keep available, habits not
  countries: [{ code: 'DEU', taps: 2, share: 1 }],
  publicationCount: 2,
  keptNow: { savedArticles: 3, followedStories: 0 },
});

async function mount(el: React.ReactElement) {
  const r = render(el);
  await act(async () => {});
  fireEvent(screen.getByTestId('stats-page'), 'layout', { nativeEvent: { layout: { width: W, height: 844 } } });
  await act(async () => {});
  return r;
}

beforeEach(() => {
  mockStats = emptyReadingStats();
  mockSetEdge.mockClear();
  mockBlockerRef.current = null;
  mockBlocker = { ref: mockBlockerRef, setEdge: (e: unknown) => mockSetEdge(e) };
});

describe('pagerEdges', () => {
  it('is at the start, the end, or neither', () => {
    expect(pagerEdges(0, 400, 3)).toEqual({ start: true, end: false });
    expect(pagerEdges(400, 400, 3)).toEqual({ start: false, end: false });
    expect(pagerEdges(800, 400, 3)).toEqual({ start: false, end: true });
    expect(pagerEdges(0, 400, 1)).toEqual({ start: true, end: true });
  });
});

describe('StatsPager', () => {
  it('before any card exists, states the rule with no share controls and no capture host', async () => {
    await mount(<StatsPager active />);
    expect(screen.getByTestId('stats-empty').props.children).toBe('library.stats.emptyTitle|library.stats.emptyBody');
    expect(screen.queryByTestId('stats-share-button')).toBeNull();
    expect(screen.queryByTestId('stats-names-switch')).toBeNull();
    expect(screen.queryByTestId('stats-capture-host')).toBeNull();
  });

  it('pages the available cards with dots, Share this card and the names switch', async () => {
    mockStats = withCards();
    await mount(<StatsPager active />);
    expect(screen.getByTestId('stats-page-reach')).toBeTruthy();
    expect(screen.getByTestId('stats-page-keep')).toBeTruthy();
    expect(screen.queryByTestId('stats-page-habits')).toBeNull();
    expect(screen.getByTestId('stats-share-button').props.accessibilityLabel).toBe('library.stats.share');
    expect(screen.getByTestId('stats-names-switch')).toBeTruthy();
  });

  it('hands the pager to the page swipe and reports its edges as it scrolls', async () => {
    mockStats = withCards();
    await mount(<StatsPager active />);
    const pager = screen.getByTestId('stats-pager');
    expect(mockBlockerRef.current).not.toBeNull();
    expect(mockSetEdge).toHaveBeenLastCalledWith({ start: true, end: false });
    fireEvent(pager, 'scroll', { nativeEvent: { contentOffset: { x: W, y: 0 } } });
    expect(mockSetEdge).toHaveBeenLastCalledWith({ start: false, end: true });
  });

  it('works outside a page swipe (no blocker)', async () => {
    mockBlocker = null;
    mockStats = withCards();
    await mount(<StatsPager active />);
    expect(screen.getByTestId('stats-pager')).toBeTruthy();
  });

  it('lays out the capture host only while the page is active', async () => {
    mockStats = withCards();
    const r = await mount(<StatsPager active={false} />);
    expect(screen.queryByTestId('stats-capture-host')).toBeNull();
    r.rerender(<StatsPager active />);
    await act(async () => {});
    expect(screen.getByTestId('stats-capture-host')).toBeTruthy();
  });

  it('lands on the card an arrival asks for', async () => {
    mockStats = withCards();
    await mount(<StatsPager active requestedCard="keep" />);
    const dot = (id: string) => StyleSheet.flatten(screen.getByTestId(`stats-dot-${id}`, { includeHiddenElements: true }).props.style);
    expect(dot('keep').width).toBe(18);
    expect(dot('reach').width).toBe(6);
  });

  it('an arrival naming a card this device cannot show lands on the first card', async () => {
    mockStats = withCards();
    await mount(<StatsPager active requestedCard="habits" />);
    const dot = (id: string) => StyleSheet.flatten(screen.getByTestId(`stats-dot-${id}`, { includeHiddenElements: true }).props.style);
    expect(dot('reach').width).toBe(18);
  });

  it('fits the card to the page box, less header, dots, share block and list end', async () => {
    mockStats = withCards();
    await mount(<StatsPager active headerHeight={106} listEndPadding={172} />);
    const frame = screen.getByTestId('stats-page-reach').props.children;
    const size = StyleSheet.flatten(frame.props.style);
    // 844 - 106 - 14 - 28 - 96 - 172 = 428 tall budget; width 400 - 32 = 368.
    expect(size.height).toBeLessThanOrEqual(428);
    expect(size.width).toBeLessThanOrEqual(368);
  });
});
