/* eslint-disable @typescript-eslint/no-require-imports */
// ux2 B3: the swipe container. RNGH and Reanimated are mocked inline: the Pan
// records its configuration and callbacks, and timing callbacks run at once.

import { act, fireEvent, render } from '@testing-library/react-native';
import React from 'react';

jest.mock('react-native-css-interop/jsx-runtime', () => {
    const R = require('react/jsx-runtime');
    return { jsx: R.jsx, jsxs: R.jsxs, Fragment: R.Fragment };
});
jest.mock('react-native-css-interop/jsx-dev-runtime', () => {
    const R = require('react/jsx-dev-runtime');
    return { jsxDEV: R.jsxDEV, Fragment: R.Fragment };
});

const mockPan: Record<string, any> = {};
jest.mock('react-native-gesture-handler', () => {
    const chain: any = new Proxy(
        {},
        {
            get: (_t, key: string) => (arg: unknown) => {
                mockPan[key] = arg;
                return chain;
            },
        },
    );
    return {
        Gesture: { Pan: () => chain },
        GestureDetector: ({ children }: any) => children,
    };
});
let mockReduceMotion = false;
jest.mock('react-native-reanimated', () => {
    const { View } = require('react-native');
    const R = require('react');
    return {
        __esModule: true,
        default: { View: (p: any) => R.createElement(View, p) },
        useSharedValue: (v: number) => R.useRef({ value: v }).current,
        useAnimatedStyle: (fn: () => unknown) => fn(),
        useReducedMotion: () => mockReduceMotion,
        withSpring: (v: number) => v,
        withTiming: (v: number, _c: unknown, cb?: (f: boolean) => void) => {
            if (cb) cb(true);
            return v;
        },
        runOnJS: (fn: any) => fn,
    };
});

import { I18nManager, Text } from 'react-native';
import SwipeTabs, { useSwipeTabsBlocker } from '../SwipeTabs';

function Blocker() {
    const ref = useSwipeTabsBlocker();
    return <Text testID="blocker">{ref ? 'has-ref' : 'none'}</Text>;
}

function setup(index = 2, count = 5) {
    const onIndexChange = jest.fn();
    const r = render(
        <SwipeTabs index={index} count={count} onIndexChange={onIndexChange} testID="swipe">
            <Blocker />
        </SwipeTabs>,
    );
    fireEvent(r.getByTestId('swipe'), 'layout', { nativeEvent: { layout: { x: 0, y: 0, width: 400, height: 700 } } });
    return { r, onIndexChange };
}

beforeEach(() => {
    mockReduceMotion = false;
    for (const k of Object.keys(mockPan)) delete mockPan[k];
    (I18nManager as any).isRTL = false;
});

describe('SwipeTabs', () => {
    it('only takes a clear horizontal drag, leaves vertical scrolling and the screen edges alone', () => {
        setup();
        expect(mockPan.activeOffsetX).toEqual([-25, 25]);
        expect(mockPan.failOffsetY).toEqual([-12, 12]);
        expect(mockPan.hitSlop).toEqual({ left: -24, right: -24 });
    });

    it('waits for a horizontal scroller inside it (the breaking strip)', () => {
        const { r } = setup();
        expect(r.getByTestId('blocker').props.children).toBe('has-ref');
        expect(mockPan.requireExternalGestureToFail).toBeDefined();
    });

    it('a long leftward drag goes to the next tab', () => {
        const { onIndexChange } = setup(2);
        act(() => mockPan.onEnd({ translationX: -300, velocityX: 0 }));
        expect(onIndexChange).toHaveBeenCalledWith(3);
    });

    it('a rightward flick goes to the previous tab', () => {
        const { onIndexChange } = setup(2);
        act(() => mockPan.onEnd({ translationX: 40, velocityX: 800 }));
        expect(onIndexChange).toHaveBeenCalledWith(1);
    });

    it('a short drag springs back without changing tab', () => {
        const { onIndexChange } = setup(2);
        act(() => mockPan.onEnd({ translationX: -60, velocityX: -100 }));
        expect(onIndexChange).not.toHaveBeenCalled();
    });

    it('mirrors in RTL', () => {
        (I18nManager as any).isRTL = true;
        const { onIndexChange } = setup(2);
        act(() => mockPan.onEnd({ translationX: -300, velocityX: 0 }));
        expect(onIndexChange).toHaveBeenCalledWith(1);
    });

    it('under Reduce Motion it just swaps, and the panel never moves', () => {
        mockReduceMotion = true;
        const { r, onIndexChange } = setup(2);
        const { StyleSheet } = require('react-native');
        mockPan.onUpdate({ translationX: -200 });
        r.rerender(
            <SwipeTabs index={2} count={5} onIndexChange={onIndexChange} testID="swipe">
                <Blocker />
            </SwipeTabs>,
        );
        const tf = StyleSheet.flatten(r.getByTestId('swipe').props.style).transform;
        expect(tf).toEqual([{ translateX: 0 }]);
        act(() => mockPan.onEnd({ translationX: -300, velocityX: 0 }));
        expect(onIndexChange).toHaveBeenCalledWith(3);
    });
});
