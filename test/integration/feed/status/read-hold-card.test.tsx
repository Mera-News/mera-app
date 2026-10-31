// The counts card while today's reading is used up (owner, final copy): level 1 says what was
// published, read and kept, and offers the rest; level 2 is the funnel, ending on when Mera reads
// again. Real stores and read hold; the counts come from a mocked useFeedCounts so the numbers are
// the owner's screenshot. Faked at the edges: reanimated, the logo, the glass and the RevenueCat SDK.
import { fireEvent, render, screen, within } from '@testing-library/react-native';
import React from 'react';
import { DashboardStatsCard } from '@/components/custom/for-you/DashboardStatsCard';
import { resetStatusCard, setNotReadWaiting } from '@/components/custom/for-you/feed-status-card';
import { limitUnlockTime } from '@/components/custom/for-you/FeedStatusDetails';
import { addFact } from '@/lib/database/services/fact-service';
import { ProcessingMode } from '@/lib/generated/graphql-types';
import { useForYouStore } from '@/lib/stores/for-you-store';
import { useMeraProtocolStore } from '@/lib/stores/mera-protocol-store';
import { useSubscriptionStore } from '@/lib/stores/subscription-store';
import { resetReadHold, setReadHold } from '@/lib/subscription/read-hold';
import { initI18nEn } from '@/test/helpers';

jest.mock('react-native-reanimated', () => {
  const { View, Text } = require('react-native');
  const R = require('react');
  return {
    __esModule: true,
    default: { View, Text },
    Easing: { bezier: () => () => 0, linear: () => 0, inOut: () => () => 0, out: () => () => 0, in: () => () => 0, ease: () => 0, cubic: () => 0 },
    FadeInDown: {},
    FadeOutUp: {},
    useReducedMotion: () => true,
    useSharedValue: (v: unknown) => R.useRef({ value: v, set(n: unknown) { this.value = n; } }).current,
    useAnimatedStyle: () => ({}),
    withTiming: (v: unknown) => v,
    withRepeat: (v: unknown) => v,
    cancelAnimation: () => {},
  };
});
jest.mock('@/components/custom/MeraLogo', () => () => null);
jest.mock('@/components/custom/GlassSurface', () => {
  const { View } = require('react-native');
  return { GlassPanel: ({ children, testID }: { children: React.ReactNode; testID?: string }) => <View testID={testID}>{children}</View> };
});
jest.mock('@/components/ui/shimmer', () => {
  const { Text } = require('react-native');
  return { ShimmerText: ({ children }: { children: React.ReactNode }) => <Text>{children}</Text> };
});
jest.mock('@/lib/mera-protocol-toolkit/core/systemRequirements', () => ({
  checkRequirements: jest.fn(() => Promise.resolve({ supported: false })),
}));
let mockCounts = { articleCount: 186350, analysedCount: 57, relevantCount: 39, readCount: 0 };
jest.mock('@/lib/hooks/use-feed-counts', () => ({
  ...jest.requireActual('@/lib/hooks/use-feed-counts'),
  useFeedCounts: () => mockCounts,
}));

jest.setTimeout(60_000);

const RESET_AT = Date.now() + 2 * 3_600_000;
const LINE_1 =
  '186,350 articles were published today. Mera read 57 and kept only 39 that matter to you.';
/** The card's visuals sit under a childless labelled button, hidden from accessibility. */
const H = { includeHiddenElements: true } as const;
const LINE_2 = 'Upgrade to save even more time by letting Mera read 149 as well.';

beforeAll(async () => {
  await initI18nEn();
  await addFact('I follow racing');
});

beforeEach(async () => {
  mockCounts = { articleCount: 186350, analysedCount: 57, relevantCount: 39, readCount: 0 };
  useSubscriptionStore.getState().reset();
  useSubscriptionStore.setState({ serverTier: 'starter' });
  useMeraProtocolStore.setState({ processingMode: ProcessingMode.Cloud });
  useForYouStore.setState({ articleCount: 186350 });
  await setReadHold({ resetAt: RESET_AT });
  setNotReadWaiting(149);
});

afterEach(() => {
  resetReadHold();
  setNotReadWaiting(null);
  resetStatusCard();
});

it('level 1 says what was published, read and kept, then offers the waiting articles', async () => {
  await render(<DashboardStatsCard testID="feed-status-card" />);
  expect(screen.getByTestId('feed-status-lead', H)).toHaveTextContent(LINE_1);
  expect(screen.getByTestId('feed-status-upsell', H)).toHaveTextContent(LINE_2);
  expect(screen.queryByText(/found .* for you/, H)).toBeNull();
});

it('with nothing waiting, the upsell line is gone and line 1 stays', async () => {
  setNotReadWaiting(0);
  await render(<DashboardStatsCard testID="feed-status-card" />);
  expect(screen.getByTestId('feed-status-lead', H)).toHaveTextContent(LINE_1);
  expect(screen.queryByTestId('feed-status-upsell', H)).toBeNull();
});

it('one kept article reads in the singular', async () => {
  mockCounts = { ...mockCounts, relevantCount: 1 };
  await render(<DashboardStatsCard testID="feed-status-card" />);
  expect(screen.getByTestId('feed-status-lead', H)).toHaveTextContent(
    '186,350 articles were published today. Mera read 57 and kept only 1 that matters to you.',
  );
});

it('none kept says so', async () => {
  mockCounts = { ...mockCounts, relevantCount: 0 };
  await render(<DashboardStatsCard testID="feed-status-card" />);
  expect(screen.getByTestId('feed-status-lead', H)).toHaveTextContent(
    '186,350 articles were published today. Mera read 57 and none matter to you yet.',
  );
});

it('level 2 is the funnel and ends on when Mera reads again; no Stage or Cloud scoring', async () => {
  useForYouStore.setState({ batchProgress: { done: 321, total: 437 } } as never);
  await render(<DashboardStatsCard testID="feed-status-card" />);
  await fireEvent.press(screen.getByTestId('feed-status-card-toggle'));
  const details = screen.getByTestId('feed-status-details', H);
  const rows = [
    ['Published today', '186,350'],
    ['Read by Mera', '57'],
    ['Worth your time', '39'],
    ['Waiting for Mera', '149'],
  ];
  for (const [label, value] of rows) {
    expect(within(details).getByText(label, H)).toBeTruthy();
    expect(within(details).getByText(value, H)).toBeTruthy();
  }
  expect(within(details).queryByText('Stage', H)).toBeNull();
  expect(within(details).queryByText('Cloud scoring', H)).toBeNull();
  expect(within(details).queryByText('Match your interests', H)).toBeNull();
  expect(screen.getByTestId('feed-status-reads-again', H)).toHaveTextContent(
    `Mera reads again at ${limitUnlockTime(RESET_AT)}, or now with Individual.`,
  );
});
