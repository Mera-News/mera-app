// The counts card while a model lane is down (route1): the title leads, only the down lanes are listed
// as paused, two buttons keep the reader reading, "?" opens the why. Faked at the edges like read-hold-card.
import { fireEvent, render, screen } from '@testing-library/react-native';
import React from 'react';
import { Linking } from 'react-native';
import { DashboardStatsCard } from '@/components/custom/for-you/DashboardStatsCard';
import { resetStatusCard } from '@/components/custom/for-you/feed-status-card';
import { addFact } from '@/lib/database/services/fact-service';
import { ProcessingMode } from '@/lib/generated/graphql-types';
import { useForYouStore } from '@/lib/stores/for-you-store';
import { useMeraProtocolStore } from '@/lib/stores/mera-protocol-store';
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
jest.mock('@/components/ui/help-modal', () => {
  const { View } = require('react-native');
  const R = require('react');
  // Like the real card: onClosed runs once it has fully gone.
  const HelpModal = ({ open, onClosed, children, title }: { open: boolean; onClosed?: () => void; children: React.ReactNode; title: string }) => {
    const was = R.useRef(false);
    R.useEffect(() => {
      if (was.current && !open) onClosed?.();
      was.current = open;
    }, [open, onClosed]);
    return open ? <View testID="help-open" accessibilityLabel={title}>{children}</View> : null;
  };
  return { HelpModal };
});
const mockNavigate = jest.fn();
jest.mock('@/components/custom/nav/navigate-to-page', () => ({ navigateToPage: (...a: unknown[]) => mockNavigate(...a) }));

const H = { includeHiddenElements: true } as const;

beforeAll(async () => {
  await initI18nEn();
  await addFact('I follow racing');
});
beforeEach(() => {
  mockNavigate.mockClear();
  useMeraProtocolStore.setState({ processingMode: ProcessingMode.Cloud, chatInCloud: false } as never);
  useForYouStore.setState({ laneOutage: { scoring: { since: 1 }, 'chat-single': { since: 2 } } });
});
afterEach(() => {
  useForYouStore.setState({ laneOutage: {} });
  resetStatusCard();
});

it('leads with the title and lists only the paused lanes', async () => {
  await render(<DashboardStatsCard testID="c" />);
  expect(screen.getByTestId('feed-status-lead', H)).toHaveTextContent("Mera's private AI is down for now.");
  expect(screen.getByTestId('feed-outage-paused', H)).toHaveTextContent('Paused: new article picks, chat');
  expect(screen.getByTestId('feed-outage-working', H)).toHaveTextContent(
    'Working: followed stories, World, Search, Saved, your Feed',
  );
});

it('the buttons open Followed stories and World', async () => {
  await render(<DashboardStatsCard testID="c" />);
  await fireEvent.press(screen.getByTestId('feed-outage-followed', H));
  await fireEvent.press(screen.getByTestId('feed-outage-world', H));
  expect(mockNavigate.mock.calls).toEqual([['stories'], ['world']]);
});

it('"?" opens the help, whose link opens the provider status once closed', async () => {
  const open = jest.spyOn(Linking, 'openURL').mockResolvedValue(undefined as never);
  await render(<DashboardStatsCard testID="c" />);
  expect(screen.queryByTestId('help-open', H)).toBeNull();
  await fireEvent.press(screen.getByLabelText('Why is this paused?', H));
  expect(screen.getByTestId('help-open', H)).toBeTruthy();
  expect(screen.getByText('It comes back on its own.', H)).toBeTruthy();
  expect(screen.getByText('Done', H)).toBeTruthy();
  expect(open).not.toHaveBeenCalled();
  await fireEvent.press(screen.getByTestId('feed-outage-status-link', H));
  expect(open).toHaveBeenCalledWith('https://status.near.ai');
  open.mockRestore();
});

it('On this phone never shows it; chat-in-cloud shows it for chat lanes only', async () => {
  useMeraProtocolStore.setState({ processingMode: ProcessingMode.OnDevice, chatInCloud: false } as never);
  const { unmount } = await render(<DashboardStatsCard testID="c" />);
  expect(screen.queryByTestId('feed-outage-block', H)).toBeNull();
  unmount();
  useMeraProtocolStore.setState({ chatInCloud: true } as never);
  await render(<DashboardStatsCard testID="c" />);
  expect(screen.getByTestId('feed-outage-paused', H)).toHaveTextContent('Paused: chat');
});

it('no analysing progress while scoring is down', async () => {
  useForYouStore.setState({ batchProgress: { done: 3, total: 9 } } as never);
  await render(<DashboardStatsCard testID="c" />);
  expect(screen.queryByText(/Analy[sz]ing 3 of 9/, H)).toBeNull();
});
