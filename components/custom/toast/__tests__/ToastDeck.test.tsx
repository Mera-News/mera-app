/**
 * The deck is ONE top stack, and on iOS it paints inside a FullWindowOverlay so
 * a toast fired while an RN Modal is open shows above it. The overlay attaches
 * to the key window when it MOUNTS, so it must mount only while a card exists:
 * a permanently mounted overlay would sit under any Modal presented after it.
 */
import React from 'react';
import { Platform, StyleSheet, Text } from 'react-native';
import { act, render } from '@testing-library/react-native';

jest.mock('react-native-reanimated', () => {
    const { View } = require('react-native');
    const R = require('react');
    return {
        __esModule: true,
        default: { View: R.forwardRef((p: any, ref: any) => R.createElement(View, { ...p, ref })) },
        useSharedValue: (initial: number) => {
            const { useRef } = require('react');
            return useRef({ value: initial }).current;
        },
        useAnimatedStyle: (fn: () => unknown) => fn(),
        withTiming: (v: unknown) => v,
        withSpring: (v: unknown) => v,
        runOnJS: (fn: unknown) => fn,
    };
});

// Every `.enabled(x)` a Pan is built with, in render order.
const mockPanEnabled: boolean[] = [];

jest.mock('react-native-gesture-handler', () => {
    const { View } = require('react-native');
    const R = require('react');
    const chain: any = new Proxy(
        {},
        {
            get: (_t, key) => (arg: unknown) => {
                if (key === 'enabled') mockPanEnabled.push(arg as boolean);
                return chain;
            },
        },
    );
    return {
        Gesture: { Pan: () => chain },
        GestureDetector: ({ children }: any) => children,
        GestureHandlerRootView: (p: any) => R.createElement(View, { ...p, testID: 'toast-gh-root' }),
    };
});

jest.mock('react-native-screens', () => {
    const { View } = require('react-native');
    const R = require('react');
    return {
        FullWindowOverlay: (p: any) => R.createElement(View, { testID: 'toast-full-window-overlay' }, p.children),
    };
});

jest.mock('react-native-safe-area-context', () => ({
    useSafeAreaInsets: () => ({ top: 47, bottom: 34, left: 0, right: 0 }),
}));

jest.mock('@/components/ui/toast', () => {
    const R = require('react');
    return {
        MENU_PANEL_BORDER: '#333',
        MENU_PANEL_FILL: '#111',
        TOAST_RADIUS: 16,
        ToastFrontProvider: ({ children }: any) => R.createElement(R.Fragment, null, children),
    };
});

jest.mock('@/lib/logger', () => ({
    __esModule: true,
    default: { info: jest.fn(), warn: jest.fn(), captureException: jest.fn() },
}));

import ToastDeck from '../ToastDeck';
import { closeAll, resetToastQueue, show } from '@/lib/toast/toast-queue';

function card(label: string) {
    return function CardBody() {
        return <Text>{label}</Text>;
    };
}

beforeEach(() => {
    jest.useFakeTimers();
    resetToastQueue();
});

afterEach(() => {
    act(() => closeAll());
    jest.useRealTimers();
});

describe('ToastDeck on iOS', () => {
    const originalOS = Platform.OS;
    beforeAll(() => {
        Object.defineProperty(Platform, 'OS', { value: 'ios', configurable: true });
    });
    afterAll(() => {
        Object.defineProperty(Platform, 'OS', { value: originalOS, configurable: true });
    });

    it('mounts no overlay while the deck is empty', () => {
        const { queryByTestId } = render(<ToastDeck />);
        expect(queryByTestId('toast-full-window-overlay')).toBeNull();
    });

    it('paints a card inside the full-window overlay, with its own gesture root', () => {
        const { getByTestId, getByText } = render(<ToastDeck />);
        act(() => {
            show({ duration: 5000, render: card('First') });
        });
        expect(getByTestId('toast-full-window-overlay')).toBeTruthy();
        expect(getByTestId('toast-gh-root')).toBeTruthy();
        expect(getByText('First')).toBeTruthy();
    });

    it("stacks a 'bottom' toast behind the one showing, in the same overlay", () => {
        const { getAllByTestId, getByText, queryByText } = render(<ToastDeck />);
        act(() => {
            show({ duration: 5000, render: card('First') });
            show({ placement: 'bottom', duration: 5000, render: card('Second') });
        });
        expect(getAllByTestId('toast-full-window-overlay')).toHaveLength(1);
        // FIFO: the first card is read; the second waits behind as a bare panel.
        expect(getByText('First')).toBeTruthy();
        expect(queryByText('Second')).toBeNull();
    });

    it('peeks the queued card BELOW the front one, painted UNDER it, and never dims the front', () => {
        const r = render(<ToastDeck />);
        act(() => {
            show({ duration: 5000, render: card('First') });
            show({ duration: 5000, render: card('Second') });
        });
        // The buried card needs the front's measured box to draw its panel.
        act(() => {
            r.UNSAFE_root.findAll((n: any) => typeof n.props.onLayout === 'function')[0].props.onLayout({
                nativeEvent: { layout: { width: 240, height: 80 } },
            });
        });
        const slotOf = (node: any) => {
            let cur = node;
            while (cur && !String(cur.props?.testID ?? '').startsWith('toast-slot-')) cur = cur.parent;
            return cur;
        };
        const front = slotOf(r.getByText('First'));
        const back = slotOf(r.getByTestId('toast-buried-panel'));
        expect(front).toBeTruthy();
        expect(back).toBeTruthy();
        const f = StyleSheet.flatten(front.props.style);
        const b = StyleSheet.flatten(back.props.style);
        // Stacking is EXPLICIT, not left to sibling order: the front paints on top.
        expect(f.zIndex).toBeGreaterThan(b.zIndex);
        // The front is fully opaque; only the card behind is dimmed.
        expect(f.opacity).toBe(1);
        expect(b.opacity).toBeGreaterThan(0);
        expect(b.opacity).toBeLessThan(1);
        // The back card sits lower, so its bottom edge peeks out.
        const ty = (st: any) => st.transform.find((t: any) => 'translateY' in t).translateY;
        expect(ty(b)).toBeGreaterThan(ty(f));
    });

    it('never overlaps the front card: its whole ancestor chain is opaque and the buried card is only the strip below it', () => {
        const r = render(<ToastDeck />);
        act(() => {
            show({ duration: 5000, render: card('First') });
            show({ duration: 5000, render: card('Second') });
            show({ duration: 5000, render: card('Third') });
        });
        const FRONT_H = 80;
        act(() => {
            r.UNSAFE_root.findAll((n: any) => typeof n.props.onLayout === 'function')[0].props.onLayout({
                nativeEvent: { layout: { width: 240, height: FRONT_H } },
            });
        });
        // Effective opacity of the front text: the product along the chain.
        let node: any = r.getByText('First');
        let effective = 1;
        while (node) {
            const st = node.props?.style ? StyleSheet.flatten(node.props.style) : undefined;
            if (st && typeof st.opacity === 'number') effective *= st.opacity;
            node = node.parent;
        }
        expect(effective).toBe(1);

        const ty = (st: any) => (st.transform ?? []).find((t: any) => 'translateY' in t)?.translateY ?? 0;
        const strips = r.getAllByTestId('toast-buried-panel');
        expect(strips).toHaveLength(2);
        const frontBottom = FRONT_H - 4; // Toast's own m-1 margin
        const edges: number[] = [];
        for (const strip of strips) {
            let slot: any = strip;
            while (slot && !String(slot.props?.testID ?? '').startsWith('toast-slot-')) slot = slot.parent;
            const slotStyle = StyleSheet.flatten(slot.props.style);
            const own = StyleSheet.flatten(strip.props.style);
            // No transform scale on a slot: it would move the strip's edges.
            expect(slotStyle.transform.some((t: any) => 'scale' in t && t.scale !== 1)).toBe(false);
            const top = ty(slotStyle) + (own.marginTop ?? 0);
            // Starts at or below the front's bottom edge: nothing drawn over it.
            expect(top).toBeGreaterThanOrEqual(frontBottom);
            expect(own.height).toBeGreaterThanOrEqual(12);
            edges.push(top);
        }
        // Two strips, stacked one under the other, not on top of each other.
        expect(new Set(edges).size).toBe(2);
    });

    it('a non-dismissible front card cannot be swiped; an ordinary one can', () => {
        render(<ToastDeck />);
        mockPanEnabled.length = 0;
        act(() => {
            show({ id: 'facts-combo', duration: null, dismissible: false, render: card('Updating') });
        });
        expect(mockPanEnabled.length).toBeGreaterThan(0);
        expect(mockPanEnabled[mockPanEnabled.length - 1]).toBe(false);

        act(() => closeAll());
        // Let the closed card's exit clone (never swipeable) finish and leave.
        act(() => {
            jest.advanceTimersByTime(1000);
        });
        mockPanEnabled.length = 0;
        act(() => {
            show({ duration: 5000, render: card('Ordinary') });
        });
        expect(mockPanEnabled[mockPanEnabled.length - 1]).toBe(true);
    });

    it('detaches the overlay once the last card has faded out', () => {
        const { queryByTestId } = render(<ToastDeck />);
        act(() => {
            show({ duration: 1000, render: card('Only') });
        });
        expect(queryByTestId('toast-full-window-overlay')).not.toBeNull();
        act(() => {
            jest.advanceTimersByTime(1000);
        });
        act(() => {
            jest.advanceTimersByTime(1000);
        });
        expect(queryByTestId('toast-full-window-overlay')).toBeNull();
    });
});
