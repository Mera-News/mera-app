// Settings > Feed algorithm: each control writes the one `feed_algo` settings row (merged JSON) and
// shows the stored choice. The in-memory DB is the real settings service.
import { fireEvent, render, waitFor } from '@testing-library/react-native';
import React from 'react';
import FeedAlgorithmScreen from '@/components/custom/config-mera/FeedAlgorithmScreen';
import { resetFeedViewPrefs, setFeedAlgo } from '@/components/custom/feed/feed-view-prefs';
import { getSetting } from '@/lib/database/services/setting-service';
import { FEED_ALGO_DEFAULTS, parseFeedAlgo } from '@/lib/feed-ordering/feed-algo';
import { initI18nEn } from '@/test/helpers';

jest.mock('react-native-reanimated', () => {
  const { View } = require('react-native');
  const { useRef } = require('react');
  // The segmented control builds a chained layout transition at import.
  const chain: Record<string, () => unknown> = {};
  for (const k of ['duration', 'easing', 'reduceMotion', 'delay']) chain[k] = () => chain;
  return {
    __esModule: true,
    default: { View },
    Easing: require('react-native').Easing,
    LinearTransition: chain,
    ReduceMotion: { Never: 'never', System: 'system' },
    useSharedValue: (v: unknown) => useRef({ value: v }).current,
    useAnimatedStyle: (fn: () => unknown) => fn(),
    useReducedMotion: () => false,
    withTiming: (v: unknown) => v,
  };
});
jest.mock('@/components/custom/AbstractGradientBackdrop', () => () => null);

beforeAll(initI18nEn);
beforeEach(() => resetFeedViewPrefs());

const stored = async () => parseFeedAlgo(await getSetting('feed_algo'));

it('shows the reader defaults: High kept on top reads On', async () => {
  const { getByTestId, getByText } = await render(<FeedAlgorithmScreen onBack={() => {}} />);
  expect(getByText('Feed algorithm')).toBeTruthy();
  expect(getByTestId('feed-algorithm-skipped').props.value).toBe(true);
  expect(getByTestId('feed-algorithm-medium').props.value).toBe(true);
  expect(getByTestId('feed-algorithm-seen').props.value).toBe(true);
  expect(getByTestId('feed-algorithm-high').props.value).toBe(true);
  expect(getByTestId('feed-algorithm-keep-7').props.accessibilityState).toEqual({ checked: true });
  expect(getByTestId('feed-algorithm-keep').props.accessibilityLabel).toBe('Keep important stories, 7 days');
});

it('each control writes its field into the one row, keeping the others', async () => {
  const { getByTestId } = await render(<FeedAlgorithmScreen onBack={() => {}} />);

  fireEvent(getByTestId('feed-algorithm-skipped'), 'valueChange', false);
  await waitFor(async () => expect(await stored()).toEqual({ ...FEED_ALGO_DEFAULTS, skippedIsRead: false }));

  fireEvent.press(getByTestId('feed-algorithm-keep-3'));
  await waitFor(async () => expect((await stored()).keepDays).toBe(3));

  fireEvent(getByTestId('feed-algorithm-medium'), 'valueChange', false);
  await waitFor(async () => expect((await stored()).mediumStaysAbove).toBe(false));

  fireEvent(getByTestId('feed-algorithm-seen'), 'valueChange', false);
  await waitFor(async () => expect((await stored()).seenBelowFold).toBe(false));

  // "Keep unseen High stories on top" off means High sinks.
  fireEvent(getByTestId('feed-algorithm-high'), 'valueChange', false);
  await waitFor(async () =>
    expect(await stored()).toEqual({
      skippedIsRead: false,
      keepDays: 3,
      mediumStaysAbove: false,
      seenBelowFold: false,
      highSinks: true,
    }),
  );
  expect(getByTestId('feed-algorithm-high').props.value).toBe(false);
  expect(getByTestId('feed-algorithm-keep-3').props.accessibilityState).toEqual({ checked: true });
});

it('reflects a stored choice', async () => {
  setFeedAlgo({ highSinks: true, keepDays: 2 });
  const { getByTestId } = await render(<FeedAlgorithmScreen onBack={() => {}} />);
  expect(getByTestId('feed-algorithm-high').props.value).toBe(false);
  expect(getByTestId('feed-algorithm-keep-2').props.accessibilityState).toEqual({ checked: true });
});
