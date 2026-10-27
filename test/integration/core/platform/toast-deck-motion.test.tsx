/**
 * The toast deck's motion (design "Toasts and notifications", Motion board) at the deck seam:
 * the real queue and manager drive the real ToastDeck. Reanimated is mocked per file so each
 * shared value keeps its identity across renders (a useRef), every write is recorded, and every
 * withTiming / withSpring records its target and config, then lands at once (callbacks fire).
 */
import React from 'react';
import { StyleSheet } from 'react-native';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { State } from 'react-native-gesture-handler';
import { fireGestureHandler, getByGestureTestId } from 'react-native-gesture-handler/jest-utils';
import ToastDeck from '@/components/custom/toast/ToastDeck';
import UndoToast from '@/components/custom/toast/UndoToast';
import { closeAll, resetToastQueue, show, useToastQueue } from '@/lib/toast/toast-queue';
import { useDisplayPrefsStore } from '@/lib/stores/display-prefs-store';
import MeraToast from '@/components/custom/toast/MeraToast';
import { notifiedToastDurationMs } from '@/components/custom/notifications/NotifiedToast';
import { toastManager } from '@/lib/toast-manager';
import { toastApi } from '@/lib/toast/toast-queue';
import { initI18nEn, useStrictClock } from '@/test/helpers';
import { useThemeStore } from '@/lib/theme/theme-store';
import { COLORS, tint } from '@/lib/theme/tokens';

type Anim = { kind: 'timing' | 'spring' | 'delay'; to: unknown; duration?: number; easing?: unknown; reduceMotion?: unknown };
const mockAnims: Anim[] = [];
const mockWrites: unknown[] = [];
/** The system Reduce Motion launch flag, which `useMotionAllowed` reads (as Reanimated's `useReducedMotion` does). */
const setSystemReduced = (on: boolean) => {
    const g = globalThis as { _REANIMATED_IS_REDUCED_MOTION?: boolean };
    if (on) g._REANIMATED_IS_REDUCED_MOTION = true;
    else delete g._REANIMATED_IS_REDUCED_MOTION;
};

jest.mock('react-native-reanimated', () => {
    const ReactLib = require('react');
    const base = require('react-native-reanimated/mock');
    const anim =
        (kind: 'timing' | 'spring') =>
        (to: number, config: Record<string, unknown> | undefined, cb?: (finished: boolean) => void) => {
            mockAnims.push({ kind, to, ...(config ?? {}) });
            cb?.(true);
            return to;
        };
    const useSharedValue = (init: unknown) => {
        const ref = ReactLib.useRef(null);
        if (!ref.current) {
            const box = { v: init };
            ref.current = {
                get value() {
                    return box.v;
                },
                set value(next: unknown) {
                    mockWrites.push(next);
                    box.v = next;
                },
                get: () => box.v,
                set: (next: unknown) => {
                    box.v = next;
                },
            };
        }
        return ref.current;
    };
    return {
        ...base,
        __esModule: true,
        default: base.default ?? base,
        useSharedValue,
        withTiming: anim('timing'),
        withSpring: anim('spring'),
        withDelay: (ms: number, next: unknown, reduceMotion?: unknown) => {
            mockAnims.push({ kind: 'delay', to: next, duration: ms, reduceMotion });
            return next;
        },
        Easing: { ...base.Easing, bezier: (...p: number[]) => `bezier(${p.join(',')})`, linear: 'linear' },
    };
});

// The real package pulls a native spec jest cannot parse; the overlay is a View carrying its props.
jest.mock('react-native-screens', () => {
    const { View } = require('react-native');
    const ReactLib = require('react');
    return {
        FullWindowOverlay: (props: Record<string, unknown>) =>
            ReactLib.createElement(View, { testID: 'full-window-overlay', ...props }),
    };
});

const SETTLE = 'bezier(0.22,1,0.36,1)';
const LEAVE = 'bezier(0.4,0,1,1)';
const H = 80;
const W = 358;
const ids = () => useToastQueue.getState().entries.map((e) => e.id);
const toast = (id: string, duration: number | null = 5000) =>
    show({ id, duration, render: () => <MeraToast tone="info" title={`Toast ${id}`} /> });
const layoutFront = () =>
    fireEvent(screen.getByTestId('toast-card'), 'layout', { nativeEvent: { layout: { width: W, height: H } } });
const timings = (duration: number) => mockAnims.filter((a) => a.kind === 'timing' && a.duration === duration);
const advance = (ms: number) => act(() => jest.advanceTimersByTime(ms));
const flat = (testID: string) => StyleSheet.flatten(screen.getByTestId(testID, { includeHiddenElements: true }).props.style);
const clear = () => {
    mockAnims.length = 0;
    mockWrites.length = 0;
};

beforeAll(initI18nEn);
beforeEach(() => {
    useStrictClock('2026-01-01T00:00:00Z');
    resetToastQueue();
    useDisplayPrefsStore.setState({ liteMode: false });
    setSystemReduced(false);
    clear();
});
afterEach(() => {
    closeAll();
    setSystemReduced(false);
    useThemeStore.setState({ mode: 'dark' });
});

describe('full motion', () => {
    it('arrives sliding down from -150% of its height, scale .96, opacity 0, over 420 ms ease-out', () => {
        toast('a');
        render(<ToastDeck />);
        layoutFront();
        expect(mockWrites).toEqual(expect.arrayContaining([-1.5 * H, 0.96]));
        const arrive = timings(420);
        expect(arrive.map((a) => a.to).sort()).toEqual([0, 1, 1]);
        expect(arrive.every((a) => a.easing === SETTLE)).toBe(true);
    });

    it('leaves lifting to -150% and fading over 260 ms ease-in, and the clone is gone after it', () => {
        toast('a');
        render(<ToastDeck />);
        layoutFront();
        clear();
        advance(5000);
        expect(ids()).toEqual([]);
        expect(screen.getByTestId('toast-slot-leaving')).toBeTruthy();
        const leave = timings(260);
        expect(leave.map((a) => a.to).sort()).toEqual([-1.5 * H, 0].sort());
        expect(leave.every((a) => a.easing === LEAVE)).toBe(true);
        advance(260);
        expect(screen.queryByTestId('toast-slot-leaving')).toBeNull();
    });

    it('the next in line waits as a strip through the leave, then rises from it over 320 ms', () => {
        toast('a');
        toast('b');
        render(<ToastDeck />);
        layoutFront();
        advance(5000);
        // During the leave, b is still a strip behind the leaving card.
        expect(screen.queryByTestId('toast-slot-0')).toBeNull();
        expect(screen.getByTestId('toast-slot-1')).toBeTruthy();
        expect(screen.queryByText('Toast b')).toBeNull();
        clear();
        advance(260);
        expect(screen.getByText('Toast b')).toBeTruthy();
        expect(mockWrites).toEqual(expect.arrayContaining([14, 0.94, 0.4]));
        const rise = timings(320);
        expect(rise.map((a) => a.to).sort()).toEqual([0, 1, 1]);
        expect(rise.every((a) => a.easing === SETTLE)).toBe(true);
    });

    it('the risen card keeps its own full duration, counted from when it rose', () => {
        toast('a');
        toast('b');
        render(<ToastDeck />);
        layoutFront();
        advance(5000);
        advance(260);
        advance(4900);
        expect(ids()).toEqual(['b']);
        advance(100);
        expect(ids()).toEqual([]);
    });

    it('a strip fades in from -8 over 320 ms when its card queues', () => {
        toast('a');
        render(<ToastDeck />);
        layoutFront();
        clear();
        act(() => {
            toast('b');
        });
        expect(mockWrites).toContain(-8);
        expect(timings(320).map((a) => a.to).sort()).toEqual([0, 1]);
    });

    it('strips hang below the front, never over it: 12 then 8 pt, inset 14 and 28 a side', () => {
        toast('a');
        toast('b');
        toast('c');
        toast('d');
        render(<ToastDeck />);
        layoutFront();
        const strips = screen.getAllByTestId('toast-buried-panel', { includeHiddenElements: true });
        expect(strips).toHaveLength(2);
        const [two, one] = strips.map((s) => StyleSheet.flatten(s.props.style));
        expect(one).toMatchObject({ marginTop: H, height: 12, width: W - 28 });
        expect(two).toMatchObject({ marginTop: H + 12, height: 8, width: W - 56 });
        expect(flat('toast-slot-0').zIndex).toBeGreaterThan(flat('toast-slot-1').zIndex);
    });

    it('light mode strips stay close to the white card: a faint shade and a light edge', () => {
        useThemeStore.setState({ mode: 'light' });
        toast('a');
        toast('b');
        toast('c');
        render(<ToastDeck />);
        layoutFront();
        const shades = screen
            .getAllByTestId('toast-strip-shade', { includeHiddenElements: true })
            .map((s) => StyleSheet.flatten(s.props.style).backgroundColor);
        expect(shades.sort()).toEqual(['rgba(0,0,0,0.03)', 'rgba(0,0,0,0.06)']);
        const edges = screen
            .getAllByTestId('toast-strip-body', { includeHiddenElements: true })
            .map((s) => StyleSheet.flatten(s.props.style).borderColor);
        expect(edges).toEqual([tint(COLORS.light.ink, 0.06), tint(COLORS.light.ink, 0.06)]);
    });

    it('dark mode strips keep the board shades (#1B1A1E, #18171A under the card)', () => {
        toast('a');
        toast('b');
        toast('c');
        render(<ToastDeck />);
        layoutFront();
        const shades = screen
            .getAllByTestId('toast-strip-shade', { includeHiddenElements: true })
            .map((s) => StyleSheet.flatten(s.props.style).backgroundColor);
        expect(shades.sort()).toEqual(['rgba(0,0,0,0.13)', 'rgba(0,0,0,0.23)']);
    });

    it('an inline action inside the deck (under the swipe detector) still takes a tap', async () => {
        toastManager.setToastInstance(toastApi);
        const onUndo = jest.fn(() => true);
        toastManager.showUndoToast({ title: 'Showing fewer from AD.nl', undoLabel: 'Undo', undoneTitle: 'Change undone', onUndo });
        render(<ToastDeck />);
        layoutFront();
        await act(async () => {
            fireEvent.press(screen.getByTestId('feedback-undo'));
            await Promise.resolve();
        });
        expect(onUndo).toHaveBeenCalledTimes(1);
        expect(screen.getByText('Change undone')).toBeTruthy();
    });
});

it('the overlay stays not modal to VoiceOver', () => {
    toast('a');
    render(<ToastDeck />);
    expect(screen.getByTestId('full-window-overlay').props.unstable_accessibilityContainerViewIsModal).toBe(false);
});

describe('swipe', () => {
    const pan = () => getByGestureTestId('toast-pan-a');
    const swipe = (translationY: number, velocityY = 0) =>
        act(() =>
            fireGestureHandler(pan(), [
                { state: State.BEGAN, translationY: 0 },
                { state: State.ACTIVE, translationY: 0 },
                { state: State.ACTIVE, translationY },
                { state: State.END, translationY, velocityY },
            ]),
        );

    it('up past 36 pt dismisses, lifting off over 260 ms', () => {
        toast('a');
        render(<ToastDeck />);
        layoutFront();
        clear();
        swipe(-40);
        expect(ids()).toEqual([]);
        expect(timings(260).some((a) => a.to === -40 - 1.5 * H)).toBe(true);
        // A swiped card is not replayed as an exit clone.
        expect(screen.queryByTestId('toast-slot-leaving')).toBeNull();
    });

    it('less than 36 pt snaps back over 240 ms ease-out, with no spring overshoot', () => {
        toast('a');
        render(<ToastDeck />);
        layoutFront();
        clear();
        swipe(-30);
        expect(ids()).toEqual(['a']);
        expect(mockAnims.filter((a) => a.kind === 'spring')).toEqual([]);
        expect(timings(240)).toEqual([expect.objectContaining({ to: 0, easing: SETTLE })]);
    });

    it('a downward pull moves the card a fifth of the finger', () => {
        toast('a');
        render(<ToastDeck />);
        layoutFront();
        clear();
        swipe(100);
        expect(mockWrites).toContain(20);
        expect(ids()).toEqual(['a']);
    });
});

describe('reduced: Lite or system Reduce Motion fades only, 180 ms', () => {
    it.each([
        ['system Reduce Motion', () => setSystemReduced(true)],
        ['Lite', () => useDisplayPrefsStore.setState({ liteMode: true })],
    ])('%s: arrive and leave are opacity fades that Lite does not cut', (_name, enable) => {
        enable();
        toast('a');
        render(<ToastDeck />);
        layoutFront();
        expect(timings(420)).toEqual([]);
        expect(mockWrites).not.toContain(-1.5 * H);
        const fadeIn = timings(180);
        expect(fadeIn).toEqual([expect.objectContaining({ to: 1, easing: 'linear', reduceMotion: 'never' })]);
        clear();
        advance(5000);
        expect(timings(260)).toEqual([]);
        expect(timings(180)).toEqual([expect.objectContaining({ to: 0, reduceMotion: 'never' })]);
        advance(180);
        expect(screen.queryByTestId('toast-slot-leaving')).toBeNull();
    });

    const showBar = () =>
        show({
            id: 'p',
            duration: null,
            render: () => <MeraToast tone="neutral" title="Updating" body="b" progress progressTestID="bar" />,
        });

    it('the progress bar stands still, drawn as a segment parked mid-track', () => {
        setSystemReduced(true);
        showBar();
        render(<ToastDeck />);
        layoutFront();
        expect(screen.getByTestId('bar', { includeHiddenElements: true })).toBeTruthy();
        expect(screen.getByTestId('bar-segment', { includeHiddenElements: true })).toBeTruthy();
        expect(mockAnims.some((a) => a.duration === 1400)).toBe(false);
    });

    it('with motion on, the same bar sweeps (the control for the still case)', () => {
        showBar();
        render(<ToastDeck />);
        layoutFront();
        expect(screen.getByTestId('bar-segment', { includeHiddenElements: true })).toBeTruthy();
        expect(timings(1400)).toEqual([expect.objectContaining({ easing: 'linear' })]);
    });
});

describe('a notified toast', () => {
    const notice = () => {
        toastManager.setToastInstance(toastApi);
        toastManager.showNoticeToast({ title: 'Calibrated', body: 'b', type: 'calibration' });
    };

    it.each([
        ['system Reduce Motion', () => setSystemReduced(true)],
        ['Lite', () => useDisplayPrefsStore.setState({ liteMode: true })],
    ])('%s: holds 4 s, then fades over 180 ms, and neither leg is cut', (_name, enable) => {
        enable();
        notice();
        expect(useToastQueue.getState().entries[0].duration).toBe(4000 + 180);
        render(<ToastDeck />);
        layoutFront();
        const delay = mockAnims.find((a) => a.kind === 'delay');
        expect(delay).toMatchObject({ duration: 4000, reduceMotion: 'never' });
        expect(delay?.to).toBe(1);
        expect(timings(180)).toContainEqual(expect.objectContaining({ to: 1, reduceMotion: 'never' }));
        expect(timings(450)).toEqual([]);
    });

    it.each([
        ['full motion', () => undefined, true],
        ['Lite', () => useDisplayPrefsStore.setState({ liteMode: true }), false],
    ])('%s: once its own leave has played, the deck replays no exit clone', (_name, enable, canFly) => {
        enable();
        notice();
        render(<ToastDeck />);
        layoutFront();
        advance(notifiedToastDurationMs(canFly));
        expect(ids()).toEqual([]);
        expect(screen.queryByTestId('toast-slot-leaving')).toBeNull();
    });

    it('closed by its button during the hold, it still lifts off like any toast', () => {
        toastManager.setToastInstance(toastApi);
        toastManager.showNoticeToast({
            title: 'Update ready',
            type: 'update_available',
            button: { label: 'Restart', onPress: () => undefined },
        });
        render(<ToastDeck />);
        layoutFront();
        fireEvent.press(screen.getByTestId('notified-toast-button'));
        expect(ids()).toEqual([]);
        expect(screen.getByTestId('toast-slot-leaving')).toBeTruthy();
    });
});

describe('the undo swap', () => {
    const mount = () =>
        render(
            <UndoToast
                title="Showing fewer from AD.nl"
                undoLabel="Undo"
                undoneTitle="Change undone"
                undoTestID="undo"
                onUndo={async () => true}
            />,
        );

    it('crossfades the undone face in from 4 pt below over 220 ms', async () => {
        mount();
        clear();
        await act(async () => {
            fireEvent.press(screen.getByTestId('undo'));
            await Promise.resolve();
        });
        expect(screen.getByText('Change undone')).toBeTruthy();
        expect(mockWrites).toContain(4);
        const swap = timings(220);
        expect(swap.map((a) => a.to).sort()).toEqual([0, 1]);
        expect(swap.every((a) => a.easing === SETTLE)).toBe(true);
    });

    it('under Reduce Motion the swap is a 180 ms fade', async () => {
        setSystemReduced(true);
        mount();
        clear();
        await act(async () => {
            fireEvent.press(screen.getByTestId('undo'));
            await Promise.resolve();
        });
        expect(timings(220)).toEqual([]);
        expect(timings(180)).toEqual([expect.objectContaining({ to: 1, reduceMotion: 'never' })]);
    });
});
