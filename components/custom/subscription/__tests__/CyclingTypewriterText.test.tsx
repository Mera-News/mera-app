/* eslint-disable @typescript-eslint/no-require-imports */
// CyclingTypewriterText — the four properties that make a typewriter in a list
// header acceptable rather than merely pretty.
//
//   1. it advances (types, then moves to the next line, then wraps)
//   2. reduced motion renders a whole line and never ticks
//   3. the screen reader is handed the COMPLETE line, not the typed prefix
//   4. nothing is left running when it unmounts or loses focus

import { act, render } from '@testing-library/react-native';
import React from 'react';

const mockAnimationsActive = { value: true };
jest.mock('@/lib/hooks/use-is-focused-safe', () => ({
    useAnimationsActive: () => mockAnimationsActive.value,
}));

// Spied, NOT jest.mock'd: react-native-css-interop reads
// `AccessibilityInfo.isReduceMotionEnabled` at import time, so replacing the
// whole module leaves it undefined and the NativeWind jsx-runtime dies before
// any test runs.
import { AccessibilityInfo } from 'react-native';

const mockReduceMotion = { enabled: false };
const mockRemove = jest.fn();

import CyclingTypewriterText from '../CyclingTypewriterText';

const LINES = ['abc', 'de'];
const TYPE_MS = 10;
const HOLD_MS = 100;

const renderIt = (lines: string[] = LINES) =>
    render(
        <CyclingTypewriterText
            testID="tw"
            lines={lines}
            typeMs={TYPE_MS}
            holdMs={HOLD_MS}
        />,
    );

/** Flush the mount-time `isReduceMotionEnabled()` promise. */
const settle = async () => {
    await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
    });
};

const advance = (ms: number) => act(() => { jest.advanceTimersByTime(ms); });

/** Advance N typing ticks. One `act` per tick on purpose: the next timeout is
 *  only scheduled by the effect that runs AFTER React commits the previous
 *  character, so a single large `advanceTimersByTime` would fire exactly one. */
const typeChars = (n: number) => { for (let i = 0; i < n; i++) advance(TYPE_MS); };

/** The visible (typed) string. */
const typed = (api: ReturnType<typeof renderIt>) =>
    api.getByTestId('tw-text').props.children as string;

beforeEach(() => {
    jest.useFakeTimers();
    mockAnimationsActive.value = true;
    mockReduceMotion.enabled = false;
    mockRemove.mockClear();
    jest
        .spyOn(AccessibilityInfo, 'isReduceMotionEnabled')
        .mockImplementation(() => Promise.resolve(mockReduceMotion.enabled));
    jest
        .spyOn(AccessibilityInfo, 'addEventListener')
        .mockImplementation(() => ({ remove: mockRemove }) as never);
});

afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
    jest.restoreAllMocks();
});

describe('typing and cycling', () => {
    it('types the first line one character at a time', async () => {
        const api = renderIt();
        await settle();

        expect(typed(api)).toBe('');
        typeChars(1);
        expect(typed(api)).toBe('a');
        typeChars(1);
        expect(typed(api)).toBe('ab');
        typeChars(1);
        expect(typed(api)).toBe('abc');
    });

    it('holds the finished line, then advances to the next and wraps around', async () => {
        const api = renderIt();
        await settle();

        typeChars(3); // finish 'abc'
        expect(typed(api)).toBe('abc');

        // Still holding — the hold is what makes it readable rather than a blur.
        advance(HOLD_MS - 1);
        expect(typed(api)).toBe('abc');

        advance(1); // hold elapses -> line 2, reset to zero characters
        expect(typed(api)).toBe('');
        typeChars(2);
        expect(typed(api)).toBe('de');

        advance(HOLD_MS); // wraps back to line 1
        typeChars(1);
        expect(typed(api)).toBe('a');
    });
});

describe('reduced motion', () => {
    it('renders a complete line and never ticks', async () => {
        mockReduceMotion.enabled = true;
        const api = renderIt();
        await settle();

        // Whole, immediately — no empty first frame, no reveal.
        expect(typed(api)).toBe('abc');

        advance(TYPE_MS * 20 + HOLD_MS * 5);
        // Still the same line: no typing AND no cycling, which is the point.
        expect(typed(api)).toBe('abc');
        expect(jest.getTimerCount()).toBe(0);
    });
});

describe('accessibility', () => {
    it('exposes the FULL line as the label while only a prefix is visible', async () => {
        const api = renderIt();
        await settle();
        typeChars(1); // one character typed

        const node = api.getByTestId('tw-text');
        expect(node.props.children).toBe('a');
        // A per-character moving target would make VoiceOver announce fragments.
        expect(node.props.accessibilityLabel).toBe('abc');
    });

    it('hides the height-reserving spacer copy from assistive tech', async () => {
        const api = renderIt();
        await settle();

        // The spacer exists so the block never changes height mid-cycle (which
        // in a list header would relayout the list) — but it must not be read
        // out as a second, duplicate line.
        const spacer = api.UNSAFE_getAllByType(require('react-native').Text)[0];
        expect(spacer.props.accessibilityElementsHidden).toBe(true);
        expect(spacer.props.importantForAccessibility).toBe('no-hide-descendants');
    });
});

describe('lifecycle', () => {
    it('clears its timer on unmount', async () => {
        const api = renderIt();
        await settle();
        advance(TYPE_MS);
        expect(jest.getTimerCount()).toBeGreaterThan(0);

        api.unmount();
        expect(jest.getTimerCount()).toBe(0);
    });

    it('stops ticking when the screen is unfocused or the app backgrounds', async () => {
        mockAnimationsActive.value = false;
        const api = renderIt();
        await settle();

        // Paused shows the line WHOLE — a component frozen mid-word would look
        // like a rendering bug rather than a pause.
        expect(typed(api)).toBe('abc');
        advance(TYPE_MS * 20 + HOLD_MS * 3);
        expect(typed(api)).toBe('abc');
        expect(jest.getTimerCount()).toBe(0);
    });

    it('unsubscribes from the reduce-motion listener on unmount', async () => {
        const api = renderIt();
        await settle();
        api.unmount();
        expect(mockRemove).toHaveBeenCalled();
    });
});

describe('degenerate input', () => {
    it('renders nothing when there are no lines at all', async () => {
        const api = renderIt([]);
        await settle();
        expect(api.queryByTestId('tw')).toBeNull();
        // And it stays nothing — no cycling over an empty script.
        advance(TYPE_MS * 20 + HOLD_MS * 3);
        expect(api.queryByTestId('tw')).toBeNull();
    });

    it('survives the line set SHRINKING under a stale index', async () => {
        // Real: a state-gated line drops out when the user un-saves their last
        // article, and the index was already past the new end.
        const api = render(
            <CyclingTypewriterText testID="tw" lines={['one', 'two', 'three']} typeMs={TYPE_MS} holdMs={HOLD_MS} />,
        );
        await settle();
        typeChars(3); advance(HOLD_MS); // -> index 1
        typeChars(3); advance(HOLD_MS); // -> index 2

        api.rerender(
            <CyclingTypewriterText testID="tw" lines={['one']} typeMs={TYPE_MS} holdMs={HOLD_MS} />,
        );
        typeChars(3);

        expect(typed(api)).toBe('one');
    });
});

export {};
