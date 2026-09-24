/**
 * The deck is ONE top stack, and on iOS it paints inside a FullWindowOverlay so
 * a toast fired while an RN Modal is open shows above it. The overlay attaches
 * to the key window when it MOUNTS, so it must mount only while a card exists:
 * a permanently mounted overlay would sit under any Modal presented after it.
 */
import React from 'react';
import { Platform, Text } from 'react-native';
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

jest.mock('react-native-gesture-handler', () => {
    const { View } = require('react-native');
    const R = require('react');
    const chain: any = new Proxy({}, { get: () => () => chain });
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
