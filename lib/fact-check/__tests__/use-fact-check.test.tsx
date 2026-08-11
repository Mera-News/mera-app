// useFactCheck — the request driver, after polling was removed.
//
// The behaviours worth breaking a build over:
//   • a cross-user cache hit (the mutation itself returns `complete`) goes tap →
//     result with NO spinner;
//   • THERE IS NO POLL. A non-terminal answer settles on `queued` and the hook
//     arms nothing — asserted by CALL COUNT after advancing the clock well past
//     the old 60s deadline, because a phase assertion alone would still pass
//     with a stray timer alive;
//   • every observation is written to the on-device table, which is the only
//     thing that makes leaving the screen free;
//   • the mount read costs NOTHING for an article this device never asked
//     about, and nothing at all when the feature is switched off.

const mockRequestFactCheck = jest.fn();
const mockGetFactCheck = jest.fn();

jest.mock('../fact-check-service', () => ({
    FactCheckService: {
        requestFactCheck: (...a: any[]) => mockRequestFactCheck(...a),
        getFactCheck: (...a: any[]) => mockGetFactCheck(...a),
    },
}));

const mockUpsertFactCheck = jest.fn((..._a: any[]) => Promise.resolve());
const mockGetStored = jest.fn((..._a: any[]) => Promise.resolve(null as any));
jest.mock('@/lib/database/services/fact-check-record-service', () => ({
    upsertFactCheck: (...a: any[]) => mockUpsertFactCheck(...a),
    getFactCheckForArticle: (...a: any[]) => mockGetStored(...a),
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
import { PROGRESS_DELAY_MS } from '../fact-check-state';
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
        await Promise.resolve();
    });
}

describe('useFactCheck', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        mockGetStored.mockResolvedValue(null as any);
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

    it('renders an already-cached result with no spinner and no second call', async () => {
        mockRequestFactCheck.mockResolvedValue(row('complete', { verdict: 'supported' }));
        const { result } = renderHook(() => useFactCheck('a1'));
        await flush();

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
        await flush();

        act(() => result.current.start());
        expect(result.current.showProgress).toBe(false);

        await tick(PROGRESS_DELAY_MS);
        expect(result.current.showProgress).toBe(true);
    });

    // ── THE POLL IS GONE ────────────────────────────────────────────────────
    // Call counts, not phases: a phase assertion passes even if a 3s interval is
    // still ticking in the background. Advancing five minutes — five times the
    // old deadline — and finding ZERO reads is the discriminating check.
    it('never polls: a non-terminal answer settles on queued and arms nothing', async () => {
        mockRequestFactCheck.mockResolvedValue(row('pending'));
        const { result } = renderHook(() => useFactCheck('a1'));
        await flush();

        act(() => result.current.start());
        await flush();

        expect(result.current.phase).toBe('queued');
        expect(mockGetFactCheck).not.toHaveBeenCalled();

        await tick(300_000);
        expect(mockGetFactCheck).not.toHaveBeenCalled();
        expect(result.current.phase).toBe('queued');
    });

    it.each(['pending', 'running', 'failed'])(
        'treats a %s row as queued, not as a failure — the server retries on its own',
        async (status) => {
            mockRequestFactCheck.mockResolvedValue(row(status));
            const { result } = renderHook(() => useFactCheck('a1'));
            await flush();
            act(() => result.current.start());
            await flush();
            expect(result.current.phase).toBe('queued');
        },
    );

    it('treats a null row as queued too — nullable means "not written yet"', async () => {
        mockRequestFactCheck.mockResolvedValue(null);
        const { result } = renderHook(() => useFactCheck('a1'));
        await flush();
        act(() => result.current.start());
        await flush();
        expect(result.current.phase).toBe('queued');
        expect(mockGetFactCheck).not.toHaveBeenCalled();
    });

    it('treats blocked as terminal', async () => {
        mockRequestFactCheck.mockResolvedValue(row('blocked'));
        const { result } = renderHook(() => useFactCheck('a1'));
        await flush();
        act(() => result.current.start());
        await flush();
        expect(result.current.phase).toBe('ready');
        expect(result.current.result?.status).toBe('blocked');
    });

    // Persistence is what makes "you don't need to wait here" true.
    it('writes every observation to the on-device table', async () => {
        mockRequestFactCheck.mockResolvedValue(row('complete', { verdict: 'mixed' }));
        const { result } = renderHook(() =>
            useFactCheck('a1', { articleTitle: 'A headline' }),
        );
        await flush();
        act(() => result.current.start());
        await flush();

        expect(mockUpsertFactCheck).toHaveBeenCalledWith(
            expect.objectContaining({
                articleId: 'a1',
                factCheckId: 'fc1',
                articleTitle: 'A headline',
                status: 'complete',
                verdict: 'mixed',
            }),
        );
    });

    it('persists a queued row too, so the Fact checks list can show it pending', async () => {
        mockRequestFactCheck.mockResolvedValue(row('pending'));
        const { result } = renderHook(() => useFactCheck('a1'));
        await flush();
        act(() => result.current.start());
        await flush();
        expect(mockUpsertFactCheck).toHaveBeenCalledWith(
            expect.objectContaining({ articleId: 'a1', status: 'pending' }),
        );
    });

    // ── The mount read: exactly one look, and often none at all ─────────────
    it('spends nothing on mount for an article nobody on this device asked about', async () => {
        renderHook(() => useFactCheck('a1'));
        await flush();
        expect(mockGetStored).toHaveBeenCalledWith('a1');
        expect(mockGetFactCheck).not.toHaveBeenCalled();
        expect(mockRequestFactCheck).not.toHaveBeenCalled();
    });

    it('renders a stored terminal result on mount with no network call at all', async () => {
        mockGetStored.mockResolvedValue({
            id: 'r1',
            articleId: 'a1',
            factCheckId: 'fc1',
            articleTitle: null,
            status: 'complete',
            verdict: 'supported',
            payload: row('complete', { verdict: 'supported' }),
            requestedAt: 1,
            resolvedAt: 2,
        } as any);

        const { result } = renderHook(() => useFactCheck('a1'));
        await flush();

        expect(result.current.phase).toBe('ready');
        expect(result.current.result?.verdict).toBe('supported');
        expect(mockGetFactCheck).not.toHaveBeenCalled();
    });

    it('makes exactly ONE server read for a stored-but-unresolved row, never a loop', async () => {
        mockGetStored.mockResolvedValue({
            id: 'r1',
            articleId: 'a1',
            factCheckId: 'fc1',
            articleTitle: null,
            status: 'pending',
            verdict: null,
            payload: row('pending'),
            requestedAt: 1,
            resolvedAt: null,
        } as any);
        mockGetFactCheck.mockResolvedValue(row('complete', { verdict: 'disputed' }));

        const { result } = renderHook(() => useFactCheck('a1'));
        await flush();

        expect(mockGetFactCheck).toHaveBeenCalledTimes(1);
        expect(result.current.phase).toBe('ready');
        expect(result.current.result?.verdict).toBe('disputed');

        await tick(300_000);
        expect(mockGetFactCheck).toHaveBeenCalledTimes(1);
    });

    it('leaves a still-unresolved row on queued after its single read', async () => {
        mockGetStored.mockResolvedValue({
            id: 'r1',
            articleId: 'a1',
            factCheckId: 'fc1',
            articleTitle: null,
            status: 'running',
            verdict: null,
            payload: row('running'),
            requestedAt: 1,
            resolvedAt: null,
        } as any);
        mockGetFactCheck.mockResolvedValue(row('running'));

        const { result } = renderHook(() => useFactCheck('a1'));
        await flush();

        expect(result.current.phase).toBe('queued');
        expect(mockGetFactCheck).toHaveBeenCalledTimes(1);
    });

    // The panel's `factCheckEnabled` gate returns null AFTER this hook runs, so
    // without `enabled` the mount read would fire on every article open for a
    // user who has the feature off — against resolvers behind SubscriptionGuard.
    it('does not touch the database or the network when disabled', async () => {
        renderHook(() => useFactCheck('a1', { enabled: false }));
        await flush();
        expect(mockGetStored).not.toHaveBeenCalled();
        expect(mockGetFactCheck).not.toHaveBeenCalled();
    });

    it('never reports a failed mount read — it is passive and the user never asked', async () => {
        mockGetStored.mockResolvedValue({
            id: 'r1',
            articleId: 'a1',
            factCheckId: 'fc1',
            articleTitle: null,
            status: 'pending',
            verdict: null,
            payload: row('pending'),
            requestedAt: 1,
            resolvedAt: null,
        } as any);
        mockGetFactCheck.mockRejectedValue(new Error('offline'));

        const { result } = renderHook(() => useFactCheck('a1'));
        await flush();

        expect(result.current.phase).toBe('queued');
        expect(mockCaptureException).not.toHaveBeenCalled();
    });

    it('surfaces a failed request as the error phase', async () => {
        mockRequestFactCheck.mockRejectedValue(new Error('NotFound'));
        const { result } = renderHook(() => useFactCheck('a1'));
        await flush();

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
        await flush();

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
        await flush();

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
        await flush();

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
        await flush();

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
