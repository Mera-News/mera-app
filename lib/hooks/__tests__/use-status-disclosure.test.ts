import { act, renderHook } from '@testing-library/react-native';
import { useStatusDisclosure } from '../use-status-disclosure';

const MS = 3000;

describe('useStatusDisclosure', () => {
    beforeEach(() => jest.useFakeTimers());
    afterEach(() => {
        jest.runOnlyPendingTimers();
        jest.useRealTimers();
    });

    it('starts closed', () => {
        const { result } = renderHook(() => useStatusDisclosure(true, MS));
        expect(result.current.expanded).toBe(false);
    });

    it('opens on toggle and closes itself after autoCollapseMs', () => {
        const { result } = renderHook(() => useStatusDisclosure(true, MS));

        act(() => result.current.toggle());
        expect(result.current.expanded).toBe(true);

        // Not a moment early — the panel is supposed to be readable.
        act(() => {
            jest.advanceTimersByTime(MS - 1);
        });
        expect(result.current.expanded).toBe(true);

        act(() => {
            jest.advanceTimersByTime(1);
        });
        expect(result.current.expanded).toBe(false);
    });

    it('closes immediately on a second tap, and leaves no timer behind to reopen it', () => {
        const { result } = renderHook(() => useStatusDisclosure(true, MS));

        act(() => result.current.toggle());
        act(() => {
            jest.advanceTimersByTime(1000);
        });
        act(() => result.current.toggle());
        expect(result.current.expanded).toBe(false);

        // The first tap's timer must not survive to fire against a panel the
        // user has since reopened — re-open and check it lives a FULL window.
        act(() => result.current.toggle());
        act(() => {
            jest.advanceTimersByTime(MS - 1);
        });
        expect(result.current.expanded).toBe(true);
    });

    it('stays open indefinitely when no autoCollapseMs is given (the Dashboard)', () => {
        const { result } = renderHook(() => useStatusDisclosure(true));

        act(() => result.current.toggle());
        act(() => {
            jest.advanceTimersByTime(60_000);
        });
        expect(result.current.expanded).toBe(true);

        act(() => result.current.toggle());
        expect(result.current.expanded).toBe(false);
    });

    it('closes when the control that opened it goes away', () => {
        // The pipeline going idle unmounts the status glyph. Without this the
        // panel is stranded on screen with nothing left to tap to close it.
        const { result, rerender } = renderHook(
            ({ available }: { available: boolean }) => useStatusDisclosure(available),
            { initialProps: { available: true } },
        );

        act(() => result.current.toggle());
        expect(result.current.expanded).toBe(true);

        rerender({ available: false });
        expect(result.current.expanded).toBe(false);
    });

    it('does not re-open when the control comes back', () => {
        const { result, rerender } = renderHook(
            ({ available }: { available: boolean }) => useStatusDisclosure(available),
            { initialProps: { available: true } },
        );

        act(() => result.current.toggle());
        rerender({ available: false });
        rerender({ available: true });
        expect(result.current.expanded).toBe(false);
    });

    it('clears its timer on unmount', () => {
        const clearSpy = jest.spyOn(global, 'clearTimeout');
        const { result, unmount } = renderHook(() => useStatusDisclosure(true, MS));

        act(() => result.current.toggle());
        unmount();

        expect(clearSpy).toHaveBeenCalled();
        // Nothing left to fire — a stray setState after unmount is the failure
        // this guards against.
        expect(() => jest.advanceTimersByTime(MS * 2)).not.toThrow();
        clearSpy.mockRestore();
    });
});
