// useReasonWriting + pending-since: whether a Feed card may say "Writing a note". The in-flight
// set (the scoring pipeline's own projection) is the real end signal; a 15 minute backstop from
// first sight only covers a batch that never settles.
import { act, renderHook } from '@testing-library/react-native';
import { REASON_WRITING_BACKSTOP_MS, resetReasonInFlightForTest } from '@/components/custom/cards/pending-since';
import { useReasonWriting } from '@/components/custom/cards/use-reason-in-flight';
import { useForYouStore } from '@/lib/stores/for-you-store';
import { useFakeClock } from '@/test/helpers';

const NOW = '2026-10-09T10:00:00Z';
const setInFlight = (...ids: string[]) =>
    act(() => useForYouStore.getState().setReasonsInFlightIds(new Set(ids)));
const advance = (ms: number) => act(() => jest.advanceTimersByTimeAsync(ms));

beforeEach(() => {
    resetReasonInFlightForTest();
    useForYouStore.getState().setReasonsInFlightIds(new Set());
    useFakeClock(NOW);
});

describe('useReasonWriting', () => {
    it('is true while the id is in flight and false once it leaves', async () => {
        const { result } = renderHook(() => useReasonWriting('s1'));
        expect(result.current).toBe(false);
        setInFlight('s1');
        expect(result.current).toBe(true);
        setInFlight();
        expect(result.current).toBe(false);
    });

    it('ignores other ids in the set', () => {
        const { result } = renderHook(() => useReasonWriting('s1'));
        setInFlight('s2');
        expect(result.current).toBe(false);
    });

    it('gives up after the backstop since first sight', async () => {
        const { result } = renderHook(() => useReasonWriting('s1'));
        setInFlight('s1');
        await advance(REASON_WRITING_BACKSTOP_MS - 1000);
        expect(result.current).toBe(true);
        await advance(1000);
        expect(result.current).toBe(false);
    });

    it('does not restart the clock on a remount (virtualised list rows)', async () => {
        setInFlight('s1');
        const first = renderHook(() => useReasonWriting('s1'));
        expect(first.result.current).toBe(true);
        first.unmount();
        await advance(REASON_WRITING_BACKSTOP_MS + 1000);
        const second = renderHook(() => useReasonWriting('s1'));
        expect(second.result.current).toBe(false);
    });

    // FD2: first sight is forgotten when an id leaves the set, so a rescored row starts a fresh backstop.
    describe('a row back in flight after leaving', () => {
        const backInFlightAfter20Minutes = async () => {
            const hook = renderHook(() => useReasonWriting('s1'));
            setInFlight('s1');
            expect(hook.result.current).toBe(true);
            setInFlight();
            await advance(20 * 60_000);
            setInFlight('s1');
            return hook;
        };

        test('a row back in flight after leaving shows the writing state again', async () => {
            const { result } = await backInFlightAfter20Minutes();
            expect(result.current).toBe(true);
        });
    });
});
