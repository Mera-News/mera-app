// StreamingIndicator — the rotating caption must never be double-drawn.
// A keyed Animated.View with entering/exiting kept the OUTGOING caption mounted
// (and painted, outside the layout flow) while the incoming one appeared, so two
// captions were superimposed inside the fixed-height label row. The caption is
// now a single mounted node crossfaded via opacity.
/* eslint-disable @typescript-eslint/no-require-imports */

import { act, render } from '@testing-library/react-native';
import React from 'react';
import { StyleSheet, View } from 'react-native';

jest.mock('@/components/ui/text', () => {
  const { Text } = require('react-native');
  return { Text };
});
jest.mock('@/components/custom/MeraLogo', () => {
  const { View } = require('react-native');
  return { __esModule: true, default: (p: any) => <View testID="mera-logo" {...p} /> };
});
jest.mock('react-native-reanimated', () => {
  const { View } = require('react-native');
  return {
    __esModule: true,
    default: { View: (p: any) => <View {...p} /> },
    useSharedValue: (initial: unknown) => ({ value: initial }),
    useAnimatedStyle: (fn: () => unknown) => fn(),
    withTiming: (v: unknown) => v,
    withDelay: (_d: number, v: unknown) => v,
    withRepeat: (v: unknown) => v,
    withSequence: (...v: unknown[]) => v[0],
  };
});

import StreamingIndicator from '../StreamingIndicator';

describe('StreamingIndicator', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => {
    act(() => jest.runOnlyPendingTimers());
    jest.useRealTimers();
  });

  it('shows exactly ONE caption at a time across a label swap', () => {
    const { getAllByTestId } = render(<StreamingIndicator />);
    expect(getAllByTestId('streaming-caption')).toHaveLength(1);
    const first = getAllByTestId('streaming-caption')[0].props.children;

    // Cycle tick (2000ms) → mid-crossfade (the old failure window) → after swap.
    act(() => {
      jest.advanceTimersByTime(2000);
    });
    expect(getAllByTestId('streaming-caption')).toHaveLength(1);

    act(() => {
      jest.advanceTimersByTime(220);
    });
    const captions = getAllByTestId('streaming-caption');
    expect(captions).toHaveLength(1);
    expect(captions[0].props.children).not.toBe(first);

    act(() => {
      jest.advanceTimersByTime(2220);
    });
    expect(getAllByTestId('streaming-caption')).toHaveLength(1);
  });

  it('compact renders the caption row without the logo (article-card usage)', () => {
    const { getAllByTestId, queryByTestId } = render(
      <StreamingIndicator compact color="rgb(1, 2, 3)" />,
    );
    expect(queryByTestId('mera-logo')).toBeNull();
    const caption = getAllByTestId('streaming-caption');
    expect(caption).toHaveLength(1);
    // The `color` override still drives the caption colour.
    const style = StyleSheet.flatten(caption[0].props.style) as { color?: string };
    expect(style.color).toBe('rgb(1, 2, 3)');
  });

  it('renders the logo in the default (non-compact) variant', () => {
    const { queryByTestId } = render(<StreamingIndicator />);
    expect(queryByTestId('mera-logo')).not.toBeNull();
  });

  it('dotsOnly renders no label and registers no label-cycle timer', () => {
    const { queryByTestId } = render(<StreamingIndicator dotsOnly />);
    expect(queryByTestId('streaming-caption')).toBeNull();

    // If a label-cycle interval had been registered despite dotsOnly, this
    // would throw/rerender by driving setLabelIndex on an unmounted-label
    // path; asserting the caption stays absent across a couple of would-be
    // cycles is the behavioural proxy for "no timer exists".
    act(() => {
      jest.advanceTimersByTime(2220);
    });
    expect(queryByTestId('streaming-caption')).toBeNull();

    act(() => {
      jest.advanceTimersByTime(2220);
    });
    expect(queryByTestId('streaming-caption')).toBeNull();

    // Regression guard for "no timers registered at all": with dotsOnly, the
    // pending-timer count must not grow past whatever real timers (if any)
    // exist before the cycle would have fired — i.e. no setInterval/setTimeout
    // from the label-cycle effect got scheduled.
    expect(jest.getTimerCount()).toBe(0);
  });

  it('dotsOnly still renders the pulsing dots', () => {
    const { UNSAFE_getAllByType } = render(
      <StreamingIndicator dotsOnly color="rgb(9, 9, 9)" />,
    );
    // Confirm the three dots are still in the tree via their dot color —
    // no label, no logo, dots intact.
    const dotViews = UNSAFE_getAllByType(View).filter((node) => {
      const style = StyleSheet.flatten(node.props.style) as
        | { backgroundColor?: string }
        | undefined;
      return style?.backgroundColor === 'rgb(9, 9, 9)';
    });
    expect(dotViews).toHaveLength(3);
  });
});
