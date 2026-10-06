/* eslint-disable @typescript-eslint/no-require-imports */
// The Library's Stats page: the available cards stacked in one vertical list,
// each with its own Share pill, the names switch once above them, one capture
// host that draws the card being shared (only while the page is active), an
// arrival scrolling to the card it names, and before any card exists the real
// rule with no share controls.
jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string) => k, i18n: { language: 'en' } }),
}));
let mockStats: unknown = null;
jest.mock('@/lib/stats/reading-stats-source', () => ({
  loadReadingStats: () => Promise.resolve(mockStats),
}));
jest.mock('@/lib/logger', () => ({ __esModule: true, default: { captureException: jest.fn() } }));
const mockCaptureAndShare = jest.fn();
jest.mock('@/components/custom/share-stats/capture-and-share', () => ({
  captureAndShare: (...a: unknown[]) => mockCaptureAndShare(...a),
}));
jest.mock('@/components/custom/share-stats/ShareStatsCard', () => {
  const ReactLib = require('react');
  const { View } = require('react-native');
  return {
    __esModule: true,
    default: ReactLib.forwardRef((p: any, ref: any) => (
      <View ref={ref} testID={`card-${p.card}`} accessibilityHint={p.showPublicationNames ? 'names' : 'no-names'} />
    )),
    fitCardToPage: ({ width, height }: { width: number; height: number }) => ({
      width: Math.min(width, height * 0.76),
      height: Math.min(height, width / 0.76),
    }),
    hostSizeForScale: () => ({ width: 360, height: 640 }),
  };
});
jest.mock('@/components/custom/analytics/ShareCardPill', () => {
  const { Pressable } = require('react-native');
  return {
    __esModule: true,
    default: (p: any) => (
      <Pressable testID={p.testID} onPress={p.onPress} disabled={p.disabled} accessibilityLabel={p.label} />
    ),
  };
});
jest.mock('@/lib/navigation/tab-bar', () => ({ useTabBarClearance: () => 85 }));
const mockScrollTo = jest.fn();
jest.mock('react-native-reanimated', () => {
  const ReactLib = require('react');
  const { View } = require('react-native');
  return {
    __esModule: true,
    default: {
      ScrollView: ReactLib.forwardRef((p: any, ref: any) => {
        ReactLib.useImperativeHandle(ref, () => ({ scrollTo: mockScrollTo }));
        return <View {...p} />;
      }),
    },
  };
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
import { StyleSheet, Text } from 'react-native';
import { emptyReadingStats } from '@/lib/stats/reading-stats';
import StatsPage from '../StatsPage';

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

/** Runs the two animation frames the capture waits for. */
async function flushFrames() {
  await act(async () => {
    jest.runOnlyPendingTimers();
  });
  await act(async () => {
    jest.runOnlyPendingTimers();
  });
  await act(async () => {});
}

beforeEach(() => {
  mockStats = emptyReadingStats();
  mockScrollTo.mockClear();
  mockCaptureAndShare.mockReset();
});

describe('StatsPage', () => {
  it('before any card exists, states the rule with no share controls and no capture host', async () => {
    await mount(<StatsPage active />);
    expect(screen.getByTestId('stats-empty').props.children).toBe('library.stats.emptyTitle|library.stats.emptyBody');
    expect(screen.queryByTestId('stats-names-switch')).toBeNull();
    expect(screen.queryByTestId('stats-share-reach')).toBeNull();
    expect(screen.queryByTestId('stats-capture-host')).toBeNull();
  });

  it('stacks the available cards, each with its own Share this card, and the names switch once above them', async () => {
    mockStats = withCards();
    await mount(<StatsPage active />);
    expect(screen.getByTestId('stats-card-reach')).toBeTruthy();
    expect(screen.getByTestId('stats-card-keep')).toBeTruthy();
    expect(screen.queryByTestId('stats-card-habits')).toBeNull();
    expect(screen.getByTestId('stats-share-reach').props.accessibilityLabel).toBe('library.stats.share');
    expect(screen.getByTestId('stats-share-keep').props.accessibilityLabel).toBe('library.stats.share');
    expect(screen.getAllByTestId('stats-names-switch')).toHaveLength(1);
    // No pager left: no dots.
    expect(screen.queryByTestId('stats-dots')).toBeNull();
  });

  it('the names switch reaches every visible card', async () => {
    mockStats = withCards();
    await mount(<StatsPage active />);
    expect(screen.getByTestId('card-keep', { includeHiddenElements: true }).props.accessibilityHint).toBe('names');
    fireEvent.press(screen.getByTestId('stats-names-switch'));
    for (const id of ['reach', 'keep']) {
      const nodes = screen.getAllByTestId(`card-${id}`, { includeHiddenElements: true });
      for (const n of nodes) expect(n.props.accessibilityHint).toBe('no-names');
    }
  });

  it('one capture host, only while active, drawing the card being shared', async () => {
    jest.useFakeTimers();
    try {
      mockStats = withCards();
      mockCaptureAndShare.mockResolvedValue({ status: 'shared' });
      const r = await mount(<StatsPage active={false} />);
      expect(screen.queryByTestId('stats-capture-host')).toBeNull();
      r.rerender(<StatsPage active />);
      await act(async () => {});
      const hostCard = () =>
        screen.getByTestId('stats-capture-host').findAll((n: any) => /^card-/.test(n.props?.testID ?? ''))[0].props
          .testID;
      expect(hostCard()).toBe('card-reach');
      fireEvent.press(screen.getByTestId('stats-share-keep'));
      await act(async () => {});
      expect(hostCard()).toBe('card-keep');
      await flushFrames();
      expect(mockCaptureAndShare).toHaveBeenCalledTimes(1);
    } finally {
      jest.useRealTimers();
    }
  });

  it("a failed share says so under that card only, and the pills wait while one captures", async () => {
    jest.useFakeTimers();
    try {
      mockStats = withCards();
      let resolve: (v: unknown) => void = () => {};
      mockCaptureAndShare.mockImplementation(() => new Promise((r) => { resolve = r; }));
      await mount(<StatsPage active />);
      fireEvent.press(screen.getByTestId('stats-share-reach'));
      await act(async () => {});
      expect(screen.getByTestId('stats-share-keep').props.accessibilityState?.disabled ?? screen.getByTestId('stats-share-keep').props.disabled).toBeTruthy();
      await flushFrames();
      await act(async () => resolve({ status: 'unavailable' }));
      expect(screen.getByTestId('stats-share-failure-reach')).toHaveTextContent('shareStats.sharingUnavailable');
      expect(screen.queryByTestId('stats-share-failure-keep')).toBeNull();
    } finally {
      jest.useRealTimers();
    }
  });

  it('an arrival scrolls to the card it names, just under the header, once', async () => {
    mockStats = withCards();
    await mount(<StatsPage active headerHeight={106} requestedCard="keep" />);
    fireEvent(screen.getByTestId('stats-card-keep'), 'layout', {
      nativeEvent: { layout: { x: 0, y: 700, width: W, height: 500 } },
    });
    await act(async () => {});
    expect(mockScrollTo).toHaveBeenCalledWith({ y: 700 - 106 - 14, animated: false });
    mockScrollTo.mockClear();
    fireEvent(screen.getByTestId('stats-card-keep'), 'layout', {
      nativeEvent: { layout: { x: 0, y: 720, width: W, height: 500 } },
    });
    await act(async () => {});
    expect(mockScrollTo).not.toHaveBeenCalled();
  });

  it('an arrival for the first card, or one this device cannot show, stays at the top with the names switch in view', async () => {
    mockStats = withCards();
    for (const requested of ['reach', 'habits']) {
      mockScrollTo.mockClear();
      await mount(<StatsPage active requestedCard={requested} />);
      fireEvent(screen.getByTestId('stats-card-reach'), 'layout', {
        nativeEvent: { layout: { x: 0, y: 60, width: W, height: 500 } },
      });
      await act(async () => {});
      expect(mockScrollTo).not.toHaveBeenCalled();
      expect(screen.getByTestId('stats-names-switch')).toBeTruthy();
    }
  });

  it('fits each card to the content width and at most one screen of height', async () => {
    mockStats = withCards();
    await mount(<StatsPage active headerHeight={106} listEndPadding={172} />);
    const frame = screen.getByTestId('stats-card-reach').props.children[0];
    const size = StyleSheet.flatten(frame.props.style);
    // 844 - 106 - 14 - 62 (pill) - 85 (tab bar) = 577 tall budget; width 400 - 32 = 368.
    expect(size.width).toBeLessThanOrEqual(368);
    expect(size.height).toBeLessThanOrEqual(577);
    // Width binds on this phone: the card takes the full content width.
    expect(size.width).toBeCloseTo(368, 0);
  });

  it('ends with the host footer and the list-end clearance', async () => {
    mockStats = withCards();
    await mount(<StatsPage active listEndPadding={172} footer={<Text testID="how-row" />} />);
    expect(screen.getByTestId('how-row')).toBeTruthy();
    expect(screen.getByTestId('stats-scroll').props.contentContainerStyle.paddingBottom).toBe(172);
  });
});
