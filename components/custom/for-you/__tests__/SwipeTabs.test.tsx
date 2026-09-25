/* eslint-disable @typescript-eslint/no-require-imports */
// ux2 B3: the swipe container, a windowed pager. RNGH and Reanimated are
// mocked inline: the Pan records its configuration and callbacks, animated
// styles read the shared values live, and timing callbacks run at once.
//
// Owner: "cache 1 screen next and 1 screen before and warm up 1 screen next
// and 1 screen before, terminal screens would only warm up and cache 1
// screen". The neighbours are mounted and drawn off-screen, so a drag slides
// real content, and arriving at one does not remount it.

import { act, fireEvent, render } from '@testing-library/react-native';
import React, { useEffect } from 'react';

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
        // Live, as on device: the style reads the shared values whenever it is
        // read, not once at render.
        useAnimatedStyle: (fn: () => Record<string, unknown>) =>
            new Proxy(
                {},
                {
                    get: (_t, k) => (fn() as any)[k],
                    ownKeys: () => Reflect.ownKeys(fn()),
                    getOwnPropertyDescriptor: (_t, k) => ({ enumerable: true, configurable: true, value: (fn() as any)[k] }),
                },
            ),
        useReducedMotion: () => mockReduceMotion,
        withSpring: (v: number) => v,
        withTiming: (v: number, _c: unknown, cb?: (f: boolean) => void) => {
            if (cb) cb(true);
            return v;
        },
        runOnJS: (fn: any) => fn,
    };
});

const mockNotifyScrollTick = jest.fn();
jest.mock('@/lib/visibility-tick', () => ({ notifyScrollTick: () => mockNotifyScrollTick() }));

import { I18nManager, StyleSheet, Text } from 'react-native';
import SwipeTabs, { useSwipeTabsBlocker } from '../SwipeTabs';

const W = 400;
const mounts: Record<string, number> = {};
const unmounts: Record<string, number> = {};
const activeSeen: Record<string, boolean[]> = {};

function Panel({ k, active }: { k: string; active: boolean }) {
    useEffect(() => {
        mounts[k] = (mounts[k] ?? 0) + 1;
        return () => {
            unmounts[k] = (unmounts[k] ?? 0) + 1;
        };
    }, [k]);
    (activeSeen[k] ??= []).push(active);
    const blocker = useSwipeTabsBlocker();
    return <Text testID={`content-${k}`}>{blocker ? 'has-ref' : 'none'}</Text>;
}

const keyOf = (i: number) => `t${i}`;

function tree(index: number, count: number, onIndexChange: (n: number) => void) {
    return (
        <SwipeTabs
            index={index}
            count={count}
            onIndexChange={onIndexChange}
            keyOf={keyOf}
            renderPanel={(i, active) => <Panel k={keyOf(i)} active={active} />}
            testID="swipe"
        />
    );
}

function setup(index = 2, count = 5) {
    const onIndexChange = jest.fn();
    const r = render(tree(index, count, onIndexChange));
    fireEvent(r.getByTestId('swipe'), 'layout', { nativeEvent: { layout: { x: 0, y: 0, width: W, height: 700 } } });
    return { r, onIndexChange };
}

const HIDDEN = { includeHiddenElements: true } as const;
const mountedKeys = (r: any) =>
    r
        .getAllByTestId(/^swipe-panel-/, HIDDEN)
        .map((n: any) => String(n.props.testID).replace('swipe-panel-', ''));
const tx = (node: any) => StyleSheet.flatten(node.props.style).transform?.[0]?.translateX;
const rowX = (r: any) => tx(r.getByTestId('swipe-row', HIDDEN));
const panelX = (r: any, k: string) => tx(r.getByTestId(`swipe-panel-${k}`, HIDDEN));

beforeEach(() => {
    mockReduceMotion = false;
    for (const k of Object.keys(mockPan)) delete mockPan[k];
    for (const o of [mounts, unmounts, activeSeen]) for (const k of Object.keys(o)) delete (o as any)[k];
    (I18nManager as any).isRTL = false;
});

describe('SwipeTabs: the gesture', () => {
    it('only takes a clear horizontal drag, leaves vertical scrolling and the screen edges alone', () => {
        setup();
        expect(mockPan.activeOffsetX).toEqual([-25, 25]);
        expect(mockPan.failOffsetY).toEqual([-12, 12]);
        expect(mockPan.hitSlop).toEqual({ left: -24, right: -24 });
    });

    it('waits for a horizontal scroller inside any panel (the breaking strip)', () => {
        const { r } = setup();
        expect(r.getByTestId('content-t2').props.children).toBe('has-ref');
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
        const { r, onIndexChange } = setup(2);
        act(() => mockPan.onEnd({ translationX: -60, velocityX: -100 }));
        expect(onIndexChange).not.toHaveBeenCalled();
        r.rerender(tree(2, 5, onIndexChange));
        expect(rowX(r)).toBe(-2 * W);
    });
});

describe('SwipeTabs: the window (warm and cache one each side)', () => {
    it('mounts the active tab and both neighbours, active first', () => {
        const { r } = setup(2, 5);
        expect(mountedKeys(r)).toEqual(['t2', 't1', 't3']);
    });

    it('at either end mounts only the one existing neighbour', () => {
        expect(mountedKeys(setup(0, 5).r)).toEqual(['t0', 't1']);
        expect(mountedKeys(setup(4, 5).r)).toEqual(['t4', 't3']);
    });

    it('lays each panel one width from the next, and the row shows the active one', () => {
        const { r } = setup(2, 5);
        expect(panelX(r, 't1')).toBe(W);
        expect(panelX(r, 't2')).toBe(2 * W);
        expect(panelX(r, 't3')).toBe(3 * W);
        expect(rowX(r)).toBe(-2 * W);
    });

    it('a drag moves the whole row, so the real neighbour follows the finger', () => {
        const { r, onIndexChange } = setup(2, 5);
        act(() => mockPan.onUpdate({ translationX: -100 }));
        r.rerender(tree(2, 5, onIndexChange));
        expect(rowX(r)).toBe(-2 * W - 100 * 0.6);
    });

    it('a commit lands the row on the next panel, which is already mounted: no remount', () => {
        const { r, onIndexChange } = setup(2, 5);
        expect(mounts.t3).toBe(1);
        act(() => mockPan.onEnd({ translationX: -300, velocityX: 0 }));
        expect(onIndexChange).toHaveBeenCalledWith(3);
        act(() => r.rerender(tree(3, 5, onIndexChange)));
        expect(rowX(r)).toBe(-3 * W);
        expect(mounts.t3).toBe(1);
        // The window moved: t4 warmed, t1 fell out, t2 is the cached previous.
        expect(mountedKeys(r)).toEqual(['t3', 't2', 't4']);
        expect(unmounts.t1).toBe(1);
        expect(unmounts.t2).toBeUndefined();
    });

    it('going back to the previous panel does not remount it', () => {
        const { r, onIndexChange } = setup(2, 5);
        act(() => r.rerender(tree(3, 5, onIndexChange)));
        act(() => r.rerender(tree(2, 5, onIndexChange)));
        expect(mounts.t2).toBe(1);
        expect(unmounts.t2).toBeUndefined();
        expect(mounts.t3).toBe(1);
    });

    it('a pill tap that jumps several steps mounts the target and its neighbours only', () => {
        const { r, onIndexChange } = setup(0, 5);
        act(() => r.rerender(tree(4, 5, onIndexChange)));
        expect(mountedKeys(r)).toEqual(['t4', 't3']);
        expect(unmounts.t0).toBe(1);
        expect(unmounts.t1).toBe(1);
        expect(rowX(r)).toBe(-4 * W);
    });

    it('never has more than 3 panels mounted, walking every index both ways', () => {
        const { r, onIndexChange } = setup(0, 5);
        const live = () => Object.keys(mounts).filter((k) => mounts[k] - (unmounts[k] ?? 0) > 0).length;
        for (const i of [1, 2, 3, 4, 3, 2, 1, 0, 4, 0]) {
            act(() => r.rerender(tree(i, 5, onIndexChange)));
            expect(live()).toBeLessThanOrEqual(3);
            expect(mountedKeys(r).length).toBeLessThanOrEqual(3);
        }
    });

    it('draws only the active panel until it has measured its width', () => {
        const r = render(tree(2, 5, jest.fn()));
        expect(mountedKeys(r)).toEqual(['t2']);
    });
});

describe('SwipeTabs: off-screen panels', () => {
    it('tells each panel whether it is the active one', () => {
        setup(2, 5);
        expect(activeSeen.t2.at(-1)).toBe(true);
        expect(activeSeen.t1.at(-1)).toBe(false);
        expect(activeSeen.t3.at(-1)).toBe(false);
    });

    it('hides the off-screen panels from VoiceOver and from touches', () => {
        const { r } = setup(2, 5);
        for (const k of ['t1', 't3']) {
            const p = r.getByTestId(`swipe-panel-${k}`, HIDDEN);
            expect(p.props.pointerEvents).toBe('none');
            expect(p.props.accessibilityElementsHidden).toBe(true);
            expect(p.props.importantForAccessibility).toBe('no-hide-descendants');
        }
        const a = r.getByTestId('swipe-panel-t2');
        expect(a.props.pointerEvents).toBe('auto');
        expect(a.props.accessibilityElementsHidden).toBe(false);
    });
});

describe('SwipeTabs: RTL and Reduce Motion', () => {
    it('mirrors in RTL: the next tab lies to the left and a leftward drag goes back', () => {
        (I18nManager as any).isRTL = true;
        const { r, onIndexChange } = setup(2, 5);
        expect(panelX(r, 't3')).toBe(-3 * W);
        expect(rowX(r)).toBe(2 * W);
        act(() => mockPan.onEnd({ translationX: -300, velocityX: 0 }));
        expect(onIndexChange).toHaveBeenCalledWith(1);
    });

    it('under Reduce Motion a drag moves nothing, and a commit just swaps', () => {
        mockReduceMotion = true;
        const { r, onIndexChange } = setup(2, 5);
        act(() => mockPan.onUpdate({ translationX: -200 }));
        r.rerender(tree(2, 5, onIndexChange));
        expect(rowX(r)).toBe(-2 * W);
        act(() => mockPan.onEnd({ translationX: -300, velocityX: 0 }));
        expect(onIndexChange).toHaveBeenCalledWith(3);
        act(() => r.rerender(tree(3, 5, onIndexChange)));
        expect(rowX(r)).toBe(-3 * W);
        expect(mounts.t3).toBe(1);
    });
});

// Translated titles count as on screen only inside the screen's width, and the
// arriving panel was measured while it sat a width away. Nothing else ticks on
// arrival (no scroll yet), so the pager ticks once the row has landed.
describe('SwipeTabs: re-measure on arrival', () => {
    beforeEach(() => {
        jest.useFakeTimers();
        mockNotifyScrollTick.mockClear();
    });
    afterEach(() => jest.useRealTimers());

    it('ticks once after the active tab changes, and not on first mount', () => {
        const { r, onIndexChange } = setup(2, 5);
        act(() => jest.advanceTimersByTime(200));
        expect(mockNotifyScrollTick).not.toHaveBeenCalled();
        act(() => r.rerender(tree(3, 5, onIndexChange)));
        act(() => jest.advanceTimersByTime(200));
        expect(mockNotifyScrollTick).toHaveBeenCalledTimes(1);
    });
});
