// useFactCheck — the request/poll driver.
//
// The two behaviours worth breaking a build over:
//   • a cross-user cache hit (the mutation itself returns `complete`) must go
//     tap → result with NO spinner and NO poll;
//   • a 60s deadline must branch on the LAST OBSERVED status — "still working"
//     for pending/running, a failure message for `failed`.

const mockRequestFactCheck = jest.fn();
const mockGetFactCheck = jest.fn();

jest.mock('../fact-check-service', () => ({
    FactCheckService: {
        requestFactCheck: (...a: any[]) => mockRequestFactCheck(...a),
        getFactCheck: (...a: any[]) => mockGetFactCheck(...a),
    },
}));

const mockCaptureException = jest.fn();
jest.mock('@/lib/logger', () => ({
    __esModule: true,
    default: {
        captureException: (...a: unknown[]) => mockCaptureException(...a),
        warn: jest.fn(),
        error: jest.fn(),
        debug: jest.fn(),
        info: jest.fn(),
    },
}));

import { act, renderHook } from '@testing-library/react-native';
import { POLL_INTERVAL_MS, PROGRESS_DELAY_MS } from '../fact-check-state';
import { useFactCheck } from '../use-fact-check';

const row = (status: string, extra: Record<string, unknown> = {}) =>
    ({ _id: 'fc1', status, verdict: null, claims: [], citations: [], ...extra }) as any;

/** Run pending timers for `ms` and flush the promise continuations they start. */
async function tick(ms: number) {
    await act(async () => {
        jest.advanceTimersByTime(ms);
    });
}

/** Flush microtasks without moving the clock. */
async function flush() {
    await act(async () => {
        await Promise.resolve();
    });
}

describe('useFactCheck', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        jest.useFakeTimers();
    });

    afterEach(() => {
        jest.useRealTimers();
    });

    it('starts idle and does nothing without an article id', async () => {
        const { result } = renderHook(() => useFactCheck(null));
        expect(result.current.phase).toBe('idle');
        act(() => result.current.start());
        expect(mockRequestFactCheck).not.toHaveBeenCalled();
        expect(result.current.phase).toBe('idle');
    });

    it('renders an already-cached result with no spinner and no poll', async () => {
        mockRequestFactCheck.mockResolvedValue(row('complete', { verdict: 'supported' }));
        const { result } = renderHook(() => useFactCheck('a1'));

        act(() => result.current.start());
        expect(result.current.phase).toBe('working');
        // The whole point: nothing to see yet, so the panel keeps its button.
        expect(result.current.showProgress).toBe(false);

        await flush();
        expect(result.current.phase).toBe('ready');
        expect(result.current.result?.verdict).toBe('supported');
        expect(result.current.showProgress).toBe(false);
        expect(mockGetFactCheck).not.toHaveBeenCalled();
    });

    it('shows progress only once the wait becomes perceptible', async () => {
        mockRequestFactCheck.mockReturnValue(new Promise(() => {}));
        const { result } = renderHook(() => useFactCheck('a1'));

        act(() => result.current.start());
        expect(result.current.showProgress).toBe(false);

        await tick(PROGRESS_DELAY_MS);
        expect(result.current.showProgress).toBe(true);
    });

    it('polls until a terminal status, then settles', async () => {
        mockRequestFactCheck.mockResolvedValue(row('pending'));
        mockGetFactCheck
            .mockResolvedValueOnce(row('running'))
            .mockResolvedValueOnce(row('complete', { verdict: 'mixed' }));

        const { result } = renderHook(() => useFactCheck('a1'));
        act(() => result.current.start());
        await flush();

        await tick(POLL_INTERVAL_MS);
        expect(result.current.phase).toBe('working');

        await tick(POLL_INTERVAL_MS);
        expect(result.current.phase).toBe('ready');
        expect(result.current.result?.verdict).toBe('mixed');
        expect(mockGetFactCheck).toHaveBeenCalledTimes(2);
    });

    it('treats blocked as terminal', async () => {
        mockRequestFactCheck.mockResolvedValue(row('blocked'));
        const { result } = renderHook(() => useFactCheck('a1'));
        act(() => result.current.start());
        await flush();
        expect(result.current.phase).toBe('ready');
        expect(result.current.result?.status).toBe('blocked');
    });

    it('keeps polling through a transient poll failure', async () => {
        mockRequestFactCheck.mockResolvedValue(row('pending'));
        mockGetFactCheck
            .mockRejectedValueOnce(new Error('offline'))
            .mockResolvedValueOnce(row('complete'));

        const { result } = renderHook(() => useFactCheck('a1'));
        act(() => result.current.start());
        await flush();

        await tick(POLL_INTERVAL_MS);
        expect(result.current.phase).toBe('working');
        expect(mockCaptureException).toHaveBeenCalled();

        await tick(POLL_INTERVAL_MS);
        expect(result.current.phase).toBe('ready');
    });

    it('gives up after the deadline with "still working" when the run is merely slow', async () => {
        mockRequestFactCheck.mockResolvedValue(row('pending'));
        mockGetFactCheck.mockResolvedValue(row('running'));

        const { result } = renderHook(() => useFactCheck('a1'));
        act(() => result.current.start());
        await flush();

        for (let i = 0; i < 21 && result.current.phase === 'working'; i += 1) {
            await tick(POLL_INTERVAL_MS);
        }

        expect(result.current.phase).toBe('timeout');
        expect(result.current.timeoutKey).toBe('factCheck.stillWorking');
    });

    it('reports a failure when the last observed status was failed', async () => {
        mockRequestFactCheck.mockResolvedValue(row('pending'));
        mockGetFactCheck.mockResolvedValue(row('failed'));

        const { result } = renderHook(() => useFactCheck('a1'));
        act(() => result.current.start());
        await flush();

        for (let i = 0; i < 21 && result.current.phase === 'working'; i += 1) {
            await tick(POLL_INTERVAL_MS);
        }

        expect(result.current.phase).toBe('timeout');
        // `failed` is polled through, not settled on — but it IS remembered.
        expect(result.current.timeoutKey).toBe('factCheck.failed');
    });

    it('keeps waiting when the cached row is still null (nobody has asked yet)', async () => {
        // `factCheck` is nullable and never throws — a null answer means "no row
        // written yet", which is a WAIT, not a result and not an error.
        mockRequestFactCheck.mockResolvedValue(null);
        mockGetFactCheck
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce(row('complete', { verdict: 'unverifiable' }));

        const { result } = renderHook(() => useFactCheck('a1'));
        act(() => result.current.start());
        await flush();
        expect(result.current.phase).toBe('working');

        await tick(POLL_INTERVAL_MS);
        expect(result.current.phase).toBe('working');

        await tick(POLL_INTERVAL_MS);
        expect(result.current.phase).toBe('ready');
        expect(result.current.result?.verdict).toBe('unverifiable');
    });

    it('reports "still working" when nothing was ever observed before the deadline', async () => {
        mockRequestFactCheck.mockResolvedValue(null);
        mockGetFactCheck.mockResolvedValue(null);

        const { result } = renderHook(() => useFactCheck('a1'));
        act(() => result.current.start());
        await flush();

        for (let i = 0; i < 21 && result.current.phase === 'working'; i += 1) {
            await tick(POLL_INTERVAL_MS);
        }
        expect(result.current.phase).toBe('timeout');
        expect(result.current.timeoutKey).toBe('factCheck.stillWorking');
    });

    it('surfaces a failed request as the error phase', async () => {
        mockRequestFactCheck.mockRejectedValue(new Error('NotFound'));
        const { result } = renderHook(() => useFactCheck('a1'));

        act(() => result.current.start());
        await flush();

        expect(result.current.phase).toBe('error');
        expect(mockCaptureException).toHaveBeenCalled();
        expect(mockGetFactCheck).not.toHaveBeenCalled();
    });

    it('retries after an error', async () => {
        mockRequestFactCheck
            .mockRejectedValueOnce(new Error('offline'))
            .mockResolvedValueOnce(row('complete'));
        const { result } = renderHook(() => useFactCheck('a1'));

        act(() => result.current.start());
        await flush();
        expect(result.current.phase).toBe('error');

        act(() => result.current.start());
        await flush();
        expect(result.current.phase).toBe('ready');
    });

    it('ignores a second start while one is already running', async () => {
        mockRequestFactCheck.mockReturnValue(new Promise(() => {}));
        const { result } = renderHook(() => useFactCheck('a1'));

        act(() => result.current.start());
        act(() => result.current.start());
        expect(mockRequestFactCheck).toHaveBeenCalledTimes(1);
    });

    it('dismiss cancels an in-flight run and collapses to idle', async () => {
        let resolveRequest: (v: unknown) => void = () => {};
        mockRequestFactCheck.mockReturnValue(
            new Promise((resolve) => {
                resolveRequest = resolve;
            }),
        );
        const { result } = renderHook(() => useFactCheck('a1'));

        act(() => result.current.start());
        act(() => result.current.dismiss());
        expect(result.current.phase).toBe('idle');

        // The abandoned run's late answer must not write state.
        await act(async () => {
            resolveRequest(row('complete'));
        });
        expect(result.current.phase).toBe('idle');
        expect(result.current.result).toBeNull();
    });

    it('drops an in-flight run when the screen switches article', async () => {
        let resolveRequest: (v: unknown) => void = () => {};
        mockRequestFactCheck.mockReturnValue(
            new Promise((resolve) => {
                resolveRequest = resolve;
            }),
        );
        const { result, rerender } = renderHook(
            ({ id }: { id: string }) => useFactCheck(id),
            { initialProps: { id: 'a1' } },
        );

        act(() => result.current.start());
        rerender({ id: 'a2' });
        expect(result.current.phase).toBe('idle');

        await act(async () => {
            resolveRequest(row('complete'));
        });
        // The previous article's verdict must never appear under the new one.
        expect(result.current.phase).toBe('idle');
        expect(result.current.result).toBeNull();
    });
});
