// The breathing outline.
//
// This suite is the reason `components/ui/chat-ai` imports no animation
// library: the Reanimated mock below is the cost of the effect, and it is paid
// here by the one feature that wants it rather than by every consumer of the
// shared chat primitives.
/* eslint-disable @typescript-eslint/no-require-imports */

let mockReduceMotion = false;
// Records what the loop was handed, so a test can assert the pulse reverses
// rather than merely that a style object came back.
const mockWithRepeat = jest.fn((v: unknown, count: number, reverse: boolean) => ({
  __repeat: { count, reverse, inner: v },
}));

jest.mock('react-native-reanimated', () => {
  const { View } = require('react-native');
  const R = require('react');
  return {
    __esModule: true,
    default: { View: R.forwardRef((p: any, ref: any) => R.createElement(View, { ...p, ref })) },
    Easing: { inOut: (f: unknown) => f, quad: 'quad' },
    // Per-instance identity: the effect writes this and the style reads it, so
    // a mock that forgot the value between renders makes every assertion here
    // vacuous.
    useSharedValue: (initial: number) => {
      const { useRef } = require('react');
      return useRef({ value: initial }).current;
    },
    useAnimatedStyle: (fn: () => unknown) => fn(),
    useReducedMotion: () => mockReduceMotion,
    interpolateColor: (v: number, _i: number[], out: string[]) => (v >= 1 ? out[1] : out[0]),
    withRepeat: (...a: unknown[]) => mockWithRepeat(...(a as [unknown, number, boolean])),
    withTiming: (v: unknown) => v,
    cancelAnimation: () => undefined,
  };
});

jest.mock('react-native/Libraries/Components/ActivityIndicator/ActivityIndicator', () => {
  const R = require('react');
  const RN = require('react-native');
  return { __esModule: true, default: (p: any) => R.createElement(RN.View, p) };
});

import { render } from '@testing-library/react-native';
import React from 'react';
import { StyleSheet, Text } from 'react-native';
import { GLOW_BRIGHT, GLOW_DIM } from '@/components/ui/chat-ai';
import WaitBubble from '../WaitBubble';

function style() {
  // A FRESH element each time. Passing the same element reference back to
  // `rerender` makes React bail out of the subtree, so the style read would
  // still be the one computed before the mount effect ran. The rerender itself
  // stands in for what real Reanimated does on the UI thread when a shared
  // value changes, which is re-evaluate the worklet with no React render.
  const el = () => (
    <WaitBubble>
      <Text>waiting</Text>
    </WaitBubble>
  );
  const r = render(el());
  r.rerender(el());
  return StyleSheet.flatten(r.getByTestId('chat-wait-bubble').props.style) as Record<
    string,
    unknown
  >;
}

describe('WaitBubble', () => {
  beforeEach(() => {
    mockReduceMotion = false;
    mockWithRepeat.mockClear();
  });

  it('keeps the transient look it inherits from the primitive', () => {
    const s = style();
    expect(s.backgroundColor).toBe('transparent');
    expect(s.borderWidth).toBe(1);
    expect(s.elevation).toBe(0);
  });

  it('breathes: an unbounded, REVERSING pulse', () => {
    style();
    expect(mockWithRepeat).toHaveBeenCalledTimes(1);
    const [, count, reverse] = mockWithRepeat.mock.calls[0];
    expect(count).toBe(-1);
    // Reversed, so the outline fades back down instead of snapping dark and
    // restarting, which reads as a blink rather than a breath.
    expect(reverse).toBe(true);
  });

  it('rests at the DIM end while animating', () => {
    expect(style().borderColor).toBe(GLOW_DIM);
  });

  it('parks BRIGHT under reduced motion, and starts no loop', () => {
    // Someone who asked for less motion still has to see the outline. Parking
    // at the resting end would leave the wait bubble faintest for exactly the
    // people least likely to catch a subtle one.
    mockReduceMotion = true;
    const s = style();
    expect(mockWithRepeat).not.toHaveBeenCalled();
    expect(s.borderColor).toBe(GLOW_BRIGHT);
    expect(Number(s.shadowOpacity)).toBeGreaterThan(0.4);
  });

  it('glows NEUTRAL, never the accent', () => {
    // The panel keeps the only orange outline in the chat; a second one
    // competes with it rather than reading as a different kind of thing.
    mockReduceMotion = true;
    const s = style();
    expect(String(s.borderColor)).not.toMatch(/231, 138, 83/);
    expect(String(s.shadowColor)).not.toMatch(/231, 138, 83/);
  });

  it('blooms rather than drops: zero shadow offset, zero elevation', () => {
    const s = style();
    expect(s.shadowOffset).toEqual({ width: 0, height: 0 });
    expect(s.elevation).toBe(0);
  });
});
