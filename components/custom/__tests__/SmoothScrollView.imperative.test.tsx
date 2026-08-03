// SmoothScrollView — the imperative handle.
//
// `scrollToEnd` was added for the "Show related coverage" feedback nudge on the
// detail screens, and it is called through an optional chain
// (`scrollViewRef.current?.scrollToEnd(...)`) — so a handle that never exposed
// the method, or an inner ref that never received one, would be a SILENT no-op
// that `tsc` cannot catch. These assertions pin both halves: the handle exposes
// it, and it forwards to the underlying scrollable with the animated flag.
/* eslint-disable @typescript-eslint/no-require-imports */

const mockScrollTo = jest.fn();
const mockScrollToEnd = jest.fn();

// Stand in for `Animated.ScrollView`, capturing the ref the component attaches.
// Real reanimated forwards this ref to the underlying RN ScrollView instance,
// which is where `scrollTo`/`scrollToEnd` live (see AnimatedScrollViewComplement
// extends ScrollView) — this mock reproduces that contract.
jest.mock('react-native-reanimated', () => {
  const React = require('react');
  const { View } = require('react-native');
  const ScrollViewStub = React.forwardRef((props: any, ref: any) => {
    React.useImperativeHandle(ref, () => ({ scrollTo: mockScrollTo, scrollToEnd: mockScrollToEnd }), []);
    return <View {...props} />;
  });
  ScrollViewStub.displayName = 'AnimatedScrollViewStub';
  return {
    __esModule: true,
    default: { ScrollView: ScrollViewStub, View },
    interpolate: () => 0,
    runOnJS: (fn: any) => fn,
    useAnimatedScrollHandler: () => jest.fn(),
    useAnimatedStyle: (fn: any) => fn(),
    useSharedValue: (v: any) => ({ value: v }),
  };
});
jest.mock('@/lib/visibility-tick', () => ({ notifyScrollTick: jest.fn() }));

import { render } from '@testing-library/react-native';
import React from 'react';
import { Text } from 'react-native';
import SmoothScrollView, { type SmoothScrollViewRef } from '../SmoothScrollView';

beforeEach(() => jest.clearAllMocks());

describe('SmoothScrollView imperative handle', () => {
  function mount() {
    const ref = React.createRef<SmoothScrollViewRef>();
    render(
      <SmoothScrollView ref={ref}>
        <Text>body</Text>
      </SmoothScrollView>,
    );
    return ref;
  }

  it('exposes scrollToEnd and forwards it to the underlying scrollable', () => {
    const ref = mount();
    expect(typeof ref.current?.scrollToEnd).toBe('function');

    ref.current!.scrollToEnd(true);
    expect(mockScrollToEnd).toHaveBeenCalledWith({ animated: true });
  });

  it('defaults scrollToEnd to animated, like scrollToTop', () => {
    const ref = mount();
    ref.current!.scrollToEnd();
    expect(mockScrollToEnd).toHaveBeenCalledWith({ animated: true });

    ref.current!.scrollToEnd(false);
    expect(mockScrollToEnd).toHaveBeenLastCalledWith({ animated: false });
  });

  it('leaves scrollToTop untouched', () => {
    const ref = mount();
    ref.current!.scrollToTop(true);
    expect(mockScrollTo).toHaveBeenCalledWith({ y: 0, animated: true });
    expect(mockScrollToEnd).not.toHaveBeenCalled();
  });
});
