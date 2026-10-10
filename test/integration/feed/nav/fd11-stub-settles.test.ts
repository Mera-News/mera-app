// FD11-b: a legacy redirect stub redirects only after its own push has settled, never while it is
// still animating in. expo-router (a native edge) is the only mock.
import { act, renderHook } from '@testing-library/react-native';
import { useRedirectWhenSettled } from '@/components/custom/nav/LegacyRedirect';
import { useFakeClock } from '@/test/helpers';

type Cb = (e: { data?: { closing?: boolean } }) => void;
const NOW = '2026-01-01T00:00:00Z';
let listeners: Record<string, Cb>;
let unsubscribe: jest.Mock;

beforeEach(() => {
    listeners = {};
    unsubscribe = jest.fn();
    const fakeNav = {
        addListener: jest.fn((type: string, cb: Cb) => {
            listeners[type] = cb;
            return unsubscribe;
        }),
    };
    jest.requireMock('expo-router').useNavigation = jest.fn(() => fakeNav);
    useFakeClock(NOW);
});

describe('useRedirectWhenSettled', () => {
    it('runs nothing on mount', () => {
        const run = jest.fn();
        renderHook(() => useRedirectWhenSettled(run));
        expect(run).not.toHaveBeenCalled();
    });

    it('runs once when the push finishes', () => {
        const run = jest.fn();
        renderHook(() => useRedirectWhenSettled(run));
        act(() => listeners.transitionEnd({ data: { closing: false } }));
        expect(run).toHaveBeenCalledTimes(1);
    });

    it('ignores a closing transition', () => {
        const run = jest.fn();
        renderHook(() => useRedirectWhenSettled(run));
        act(() => listeners.transitionEnd({ data: { closing: true } }));
        expect(run).not.toHaveBeenCalled();
    });

    it('falls back to running at 500 ms, not before', () => {
        const run = jest.fn();
        renderHook(() => useRedirectWhenSettled(run));
        act(() => jest.advanceTimersByTime(499));
        expect(run).not.toHaveBeenCalled();
        act(() => jest.advanceTimersByTime(1));
        expect(run).toHaveBeenCalledTimes(1);
    });

    it('does not run twice when an event follows the fallback', () => {
        const run = jest.fn();
        renderHook(() => useRedirectWhenSettled(run));
        act(() => jest.advanceTimersByTime(500));
        act(() => listeners.transitionEnd({ data: { closing: false } }));
        expect(run).toHaveBeenCalledTimes(1);
    });

    it('never runs when unmounted first, and unsubscribes', () => {
        const run = jest.fn();
        const { unmount } = renderHook(() => useRedirectWhenSettled(run));
        unmount();
        act(() => jest.advanceTimersByTime(1000));
        expect(run).not.toHaveBeenCalled();
        expect(unsubscribe).toHaveBeenCalled();
    });
});
