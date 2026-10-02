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
    makeMutable: (initial: unknown) => ({ value: initial }),
    cancelAnimation: () => {},
    useReducedMotion: () => mockReduceMotion,
    Easing: { linear: (x: number) => x },
  };
});
let mockReduceMotion = false;
let mockAnimationsActive = true;
jest.mock('@/lib/hooks/use-is-focused-safe', () => ({
  useAnimationsActive: () => mockAnimationsActive,
}));
jest.mock('@/lib/stores/display-prefs-store', () => ({
  useDisplayPrefsStore: (sel: (s: { liteMode: boolean }) => unknown) => sel({ liteMode: false }),
}));

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

  it('a fixed label is the only caption and never rotates', () => {
    mockReduceMotion = false;
    mockAnimationsActive = true;
    const { getAllByTestId, unmount } = render(
      <View>
        {/* A rotating sibling keeps the shared clock running. */}
        <StreamingIndicator compact />
        <StreamingIndicator compact label="Writing a note" />
      </View>,
    );
    const fixed = () => getAllByTestId('streaming-caption')[1];
    expect(fixed().props.children).toBe('Writing a note');
    act(() => {
      jest.advanceTimersByTime(2000 * 3 + 220 * 3);
    });
    expect(getAllByTestId('streaming-caption')).toHaveLength(2);
    expect(fixed().props.children).toBe('Writing a note');
    // The rotating sibling did move, so the clock really ran.
    expect(getAllByTestId('streaming-caption')[0].props.children).not.toBe('Writing a note');
    unmount();
  });

  it('a fixed label under Reduce Motion is static text, no clock', () => {
    mockReduceMotion = true;
    const spy = jest.spyOn(global, 'setInterval');
    const { getByTestId, unmount } = render(<StreamingIndicator compact label="Writing a note" />);
    expect(spy).not.toHaveBeenCalled();
    expect(getByTestId('streaming-caption').props.children).toBe('Writing a note');
    unmount();
    spy.mockRestore();
    mockReduceMotion = false;
  });

  it('renders the logo in the default (non-compact) variant', () => {
    const { queryByTestId } = render(<StreamingIndicator />);
    expect(queryByTestId('mera-logo')).not.toBeNull();
  });

  describe('one gated clock (S9)', () => {
    beforeEach(() => {
      mockReduceMotion = false;
      mockAnimationsActive = true;
    });

    it('runs ONE caption interval however many indicators are mounted', () => {
      const spy = jest.spyOn(global, 'setInterval');
      const { unmount } = render(
        <View>
          <StreamingIndicator compact />
          <StreamingIndicator compact />
          <StreamingIndicator compact />
        </View>,
      );
      expect(spy).toHaveBeenCalledTimes(1);
      unmount();
      spy.mockRestore();
    });

    it('starts no clock under Reduce Motion, and still shows a caption', () => {
      mockReduceMotion = true;
      const spy = jest.spyOn(global, 'setInterval');
      const { getAllByTestId, unmount } = render(<StreamingIndicator compact />);
      expect(spy).not.toHaveBeenCalled();
      expect(getAllByTestId('streaming-caption')).toHaveLength(1);
      unmount();
      spy.mockRestore();
    });

    it('starts no clock while nobody can see it (blurred tab or background)', () => {
      mockAnimationsActive = false;
      const spy = jest.spyOn(global, 'setInterval');
      const { unmount } = render(<StreamingIndicator compact />);
      expect(spy).not.toHaveBeenCalled();
      unmount();
      spy.mockRestore();
    });
  });
});
