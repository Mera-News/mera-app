// useFactCheck — the WatermelonDB observer PLUS the server poll layer
// (pivot P8d re-added polling). Properties worth a build over:
//
//   • it reacts to a row being MUTATED IN PLACE, not just to rows being
//     added/removed. This is the one bug that would make the whole feature look
//     broken while every unit test built on a naive "push a new array" fake
//     still passed — see the file header of `use-fact-check.ts`. The fake query
//     below only exposes `observeWithColumns`, never `observe`, so a regression
//     back to `.observe()` fails EVERY test here with "not a function" rather
//     than silently passing;
//   • it never touches the network for an article nobody has asked about —
//     `requestFactCheck` (the GraphQL client) is called ONLY once a local
//     non-terminal row already exists;
//   • a poll that reaches its ceiling without a terminal answer becomes
//     'stalled', never 'absent' and never a fabricated 'terminal' — that
//     collapse is the exact bug r14 shipped once and had to fix;
//   • `showProgress` gates off the row's OWN `requestedAt`, not a mount timer,
//     so a job already running for a while shows immediately on mount.

/* eslint-disable @typescript-eslint/no-require-imports */

type Emit = (rows: any[]) => void;

let currentRows: any[] = [];
const subscribers = new Set<Emit>();
const observeWithColumnsCalls: string[][] = [];
const queryCalls: any[] = [];

const fakeQueryResult = {
    observeWithColumns: jest.fn((columns: string[]) => {
        observeWithColumnsCalls.push(columns);
        return {
            subscribe: (cb: Emit) => {
                subscribers.add(cb);
                // WatermelonDB emits the current matching set immediately on
                // subscribe, before any change happens.
                cb(currentRows);
                return {
                    unsubscribe: jest.fn(() => {
                        subscribers.delete(cb);
                    }),
                };
            },
        };
    }),
};

const mockQuery = jest.fn((...clauses: any[]) => {
    queryCalls.push(clauses);
    return fakeQueryResult;
});
const mockCollection = { query: mockQuery };

jest.mock('@/lib/database/index', () => ({
    __esModule: true,
    default: { get: jest.fn(() => mockCollection) },
}));

// Bare (no inline implementation, matching the codebase's established
// pattern for these wrapper mocks) — its default implementation is set fresh
// in `beforeEach` below, and giving it a fixed-arity inline implementation
// here would make the spread in the wrapper below a type error.
const mockRequestFactCheck = jest.fn();
jest.mock('../fact-check-graphql-client', () => ({
    requestFactCheck: (...a: unknown[]) => mockRequestFactCheck(...a),
}));

/** Simulate the runner landing an update — SAME row identity, new field
 *  values, mirroring an in-place WatermelonDB write rather than a fresh insert. */
function emitRows(rows: any[]) {
    currentRows = rows;
    // Snapshot: a subscriber's own cleanup (unmount) may mutate the live Set
    // while we're iterating it.
    Array.from(subscribers).forEach((cb) => cb(rows));
}

function fakeRow(overrides: Record<string, unknown> = {}) {
    return {
        id: 'row-1',
        articleId: 'a1',
        factCheckId: 'local:a1:key1',
        articleTitle: 'A headline',
        status: 'processing',
        verdict: null,
        payloadJson: JSON.stringify({
            _id: 'local:a1:key1', status: 'processing', claims: [], citations: [], checkedBy: [],
        }),
        requestedAt: new Date(),
        resolvedAt: null,
        claim: 'The dam was completed in 2019.',
        claimKey: 'key1',
        ...overrides,
    };
}

import { act, renderHook } from '@testing-library/react-native';
import { POLL_CEILING_MS, POLL_INTERVAL_MS, PROGRESS_DELAY_MS } from '../fact-check-state';
import { useFactCheck } from '../use-fact-check';

async function flush() {
    await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
    });
}

describe('useFactCheck', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        currentRows = [];
        subscribers.clear();
        observeWithColumnsCalls.length = 0;
        queryCalls.length = 0;
        // Full reset (not just clear) so a test that overrode the
        // implementation can never leak it into the next one.
        mockRequestFactCheck.mockReset();
        mockRequestFactCheck.mockImplementation(() => Promise.resolve({ terminal: false, row: null }));
        jest.useFakeTimers();
    });

    afterEach(() => {
        jest.useRealTimers();
    });

    it('is absent with no article id, and never queries the database', () => {
        const { result } = renderHook(() => useFactCheck(null));
        expect(result.current.phase).toBe('absent');
        expect(result.current.rows).toEqual([]);
        expect(mockQuery).not.toHaveBeenCalled();
    });

    it('is absent for an article nobody has asked about', async () => {
        emitRows([]);
        const { result } = renderHook(() => useFactCheck('a1'));
        await flush();
        expect(result.current.phase).toBe('absent');
        expect(result.current.rows).toEqual([]);
    });

    it('subscribes with observeWithColumns, never plain observe', () => {
        renderHook(() => useFactCheck('a1'));
        expect(observeWithColumnsCalls.length).toBeGreaterThan(0);
        // The columns the runner actually mutates in place — miss one of these
        // and an in-flight check can update on-device without the panel
        // noticing.
        expect(observeWithColumnsCalls[0]).toEqual(
            expect.arrayContaining(['status', 'verdict', 'payload_json', 'resolved_at']),
        );
    });

    it('is processing while a row is non-terminal', async () => {
        emitRows([fakeRow({ status: 'processing' })]);
        const { result } = renderHook(() => useFactCheck('a1'));
        await flush();
        expect(result.current.phase).toBe('processing');
        expect(result.current.rows).toHaveLength(1);
    });

    it.each(['pending', 'running', 'processing', 'failed'])(
        'treats a %s row as processing, not terminal — the recovery task retries it',
        async (status) => {
            emitRows([fakeRow({ status })]);
            const { result } = renderHook(() => useFactCheck('a1'));
            await flush();
            expect(result.current.phase).toBe('processing');
        },
    );

    it.each(['complete', 'blocked'])(
        'is terminal once every row is %s',
        async (status) => {
            emitRows([fakeRow({ status, verdict: 'supported' })]);
            const { result } = renderHook(() => useFactCheck('a1'));
            await flush();
            expect(result.current.phase).toBe('terminal');
        },
    );

    // ── THE LOAD-BEARING TEST ────────────────────────────────────────────────
    // The runner does not insert a second row when a check finishes — it
    // UPDATES the row `enqueueFactCheck` already wrote. A hook built on plain
    // `.observe()` would only re-emit on a row being added or removed and would
    // never notice this, leaving the panel spinning forever. Simulating a
    // same-id emission with new field values is what actually discriminates
    // that bug from a passing test.
    it('reacts when the runner updates the SAME row from processing to complete', async () => {
        const row = fakeRow({ status: 'processing' });
        emitRows([row]);
        const { result } = renderHook(() => useFactCheck('a1'));
        await flush();
        expect(result.current.phase).toBe('processing');

        act(() => {
            emitRows([{
                ...row,
                status: 'complete',
                verdict: 'supported',
                resolvedAt: new Date(),
                payloadJson: JSON.stringify({
                    _id: row.factCheckId, status: 'complete', verdict: 'supported',
                    claims: [], citations: [], checkedBy: [],
                }),
            }]);
        });

        expect(result.current.phase).toBe('terminal');
        expect(result.current.rows[0].status).toBe('complete');
        expect(result.current.rows[0].payload?.verdict).toBe('supported');
    });

    it('several claims stack: one processing and one terminal is still processing overall', async () => {
        emitRows([
            fakeRow({ id: 'row-1', status: 'complete', verdict: 'supported' }),
            fakeRow({ id: 'row-2', status: 'processing', claim: 'A second claim.' }),
        ]);
        const { result } = renderHook(() => useFactCheck('a1'));
        await flush();
        expect(result.current.phase).toBe('processing');
        expect(result.current.rows).toHaveLength(2);
    });

    it('unsubscribes on unmount', async () => {
        emitRows([fakeRow()]);
        const { unmount } = renderHook(() => useFactCheck('a1'));
        await flush();
        expect(subscribers.size).toBe(1);
        unmount();
        expect(subscribers.size).toBe(0);
    });

    it('re-subscribes when the article id changes', async () => {
        emitRows([fakeRow({ articleId: 'a1' })]);
        const { rerender } = renderHook(({ id }: { id: string }) => useFactCheck(id), {
            initialProps: { id: 'a1' },
        });
        await flush();
        expect(queryCalls).toHaveLength(1);

        rerender({ id: 'a2' });
        await flush();
        expect(queryCalls).toHaveLength(2);
    });

    // ── showProgress: gated off the row's OWN requestedAt ───────────────────
    it('suppresses the spinner for a just-started job', async () => {
        emitRows([fakeRow({ status: 'processing', requestedAt: new Date() })]);
        const { result } = renderHook(() => useFactCheck('a1'));
        await flush();
        expect(result.current.showProgress).toBe(false);
    });

    it('shows progress once the wait becomes perceptible', async () => {
        emitRows([fakeRow({ status: 'processing', requestedAt: new Date() })]);
        const { result } = renderHook(() => useFactCheck('a1'));
        await flush();
        expect(result.current.showProgress).toBe(false);

        await act(async () => {
            jest.advanceTimersByTime(PROGRESS_DELAY_MS);
        });
        expect(result.current.showProgress).toBe(true);
    });

    it('shows progress immediately for a job that has already been running a while — no second artificial delay', async () => {
        const startedLongAgo = new Date(Date.now() - 10_000);
        emitRows([fakeRow({ status: 'processing', requestedAt: startedLongAgo })]);
        const { result } = renderHook(() => useFactCheck('a1'));
        await flush();
        expect(result.current.showProgress).toBe(true);
    });

    it('never shows progress once terminal', async () => {
        emitRows([fakeRow({ status: 'complete', verdict: 'supported' })]);
        const { result } = renderHook(() => useFactCheck('a1'));
        await flush();
        expect(result.current.showProgress).toBe(false);
    });

    it('degrades a corrupt payload to a null payload rather than throwing', async () => {
        emitRows([fakeRow({ status: 'complete', payloadJson: '{not json' })]);
        const { result } = renderHook(() => useFactCheck('a1'));
        await flush();
        expect(result.current.phase).toBe('terminal');
        expect(result.current.rows[0].payload).toBeNull();
        // The mirrored column survives even when the JSON blob didn't parse.
        expect(result.current.rows[0].verdict).toBeNull();
    });

    // ── The server poll layer (pivot P8d) ───────────────────────────────────
    describe('the server poll layer', () => {
        /** Advance one poll tick and let its promise settle. Mirrors the real
         *  cadence: the timer fires, `poll()` runs synchronously, and its
         *  `requestFactCheck().then(...)` needs a microtask flush to schedule
         *  the NEXT timer — advancing the fake clock alone is not enough. */
        async function tick(ms: number) {
            await act(async () => {
                jest.advanceTimersByTime(ms);
                await Promise.resolve();
                await Promise.resolve();
            });
        }

        it('never calls the server for an article nobody has asked about', async () => {
            emitRows([]);
            renderHook(() => useFactCheck('a1'));
            await flush();
            await tick(POLL_INTERVAL_MS * 3);
            expect(mockRequestFactCheck).not.toHaveBeenCalled();
        });

        it('never calls the server once every row is terminal', async () => {
            emitRows([fakeRow({ status: 'complete', verdict: 'supported' })]);
            renderHook(() => useFactCheck('a1'));
            await flush();
            await tick(POLL_INTERVAL_MS * 3);
            expect(mockRequestFactCheck).not.toHaveBeenCalled();
        });

        it('polls immediately on mount, then every POLL_INTERVAL_MS, for a non-terminal row', async () => {
            emitRows([fakeRow({ status: 'pending', payload: null })]);
            renderHook(() => useFactCheck('a1'));
            await flush();
            expect(mockRequestFactCheck).toHaveBeenCalledTimes(1);
            expect(mockRequestFactCheck).toHaveBeenCalledWith('a1');

            await tick(POLL_INTERVAL_MS);
            expect(mockRequestFactCheck).toHaveBeenCalledTimes(2);

            await tick(POLL_INTERVAL_MS);
            expect(mockRequestFactCheck).toHaveBeenCalledTimes(3);
        });

        it('stops polling the moment the local row goes terminal (subscription-driven), not because the poll loop decided to', async () => {
            const row = fakeRow({ status: 'processing', payload: null });
            emitRows([row]);
            renderHook(() => useFactCheck('a1'));
            await flush();
            expect(mockRequestFactCheck).toHaveBeenCalledTimes(1);

            // Simulate the write a real `requestFactCheck` would have made —
            // the poll loop itself never touches `rows`, only the DB write does.
            act(() => {
                emitRows([{ ...row, status: 'complete', verdict: 'supported' }]);
            });

            await tick(POLL_INTERVAL_MS * 3);
            // No further polls: the effect re-ran with localPhase 'terminal'
            // and exited before scheduling anything.
            expect(mockRequestFactCheck).toHaveBeenCalledTimes(1);
        });

        // ── THE r14-SHAPED BUG THIS MUST NOT REINTRODUCE ────────────────────
        // A poll that gives up must be VISIBLY DISTINGUISHABLE from "no
        // result". This test fails if 'stalled' were ever collapsed into
        // 'absent' (phase would read 'absent', rows.length === 0 either way,
        // and no caller could tell "gave up" apart from "never asked").
        it('gives up at POLL_CEILING_MS and reports "stalled" — never "absent", never a fabricated "terminal"', async () => {
            emitRows([fakeRow({ status: 'pending', payload: null })]);
            const { result } = renderHook(() => useFactCheck('a1'));
            await flush();

            const ticksToReachCeiling = Math.ceil(POLL_CEILING_MS / POLL_INTERVAL_MS) + 1;
            for (let i = 0; i < ticksToReachCeiling; i += 1) {
                await tick(POLL_INTERVAL_MS);
            }

            expect(result.current.phase).toBe('stalled');
            expect(result.current.phase).not.toBe('absent');
            expect(result.current.phase).not.toBe('terminal');
            // The row is still there (a real request WAS made) — 'stalled' is
            // not the same state as "nobody asked".
            expect(result.current.rows).toHaveLength(1);

            // Polling stops once given up — it does not retry forever.
            const callsAtCeiling = mockRequestFactCheck.mock.calls.length;
            await tick(POLL_INTERVAL_MS * 3);
            expect(mockRequestFactCheck).toHaveBeenCalledTimes(callsAtCeiling);
        });

        it('re-arms a fresh, equally bounded poll on a fresh mount — "re-read once on next mount"', async () => {
            emitRows([fakeRow({ status: 'pending', payload: null })]);
            const { unmount } = renderHook(() => useFactCheck('a1'));
            await flush();
            expect(mockRequestFactCheck).toHaveBeenCalledTimes(1);
            unmount();

            mockRequestFactCheck.mockClear();
            renderHook(() => useFactCheck('a1'));
            await flush();
            expect(mockRequestFactCheck).toHaveBeenCalledTimes(1);
        });

        it('treats a request failure as "not yet confirmed", not as a crash', async () => {
            mockRequestFactCheck.mockImplementation(() => Promise.reject(new Error('network blip')));
            emitRows([fakeRow({ status: 'pending', payload: null })]);
            const { result } = renderHook(() => useFactCheck('a1'));
            // The real `requestFactCheck` never rejects (it catches and
            // degrades internally — see fact-check-graphql-client.ts), so a
            // rejection here is a defensive-programming scenario only; the
            // hook must not let it become an unhandled rejection or a crash.
            await expect(flush()).resolves.not.toThrow();
            expect(result.current.phase).toBe('processing');
        });

        it('stops polling on unmount — no dangling timers, no state updates after unmount', async () => {
            emitRows([fakeRow({ status: 'pending', payload: null })]);
            const { unmount } = renderHook(() => useFactCheck('a1'));
            await flush();
            const callsBeforeUnmount = mockRequestFactCheck.mock.calls.length;
            unmount();
            await tick(POLL_INTERVAL_MS * 5);
            expect(mockRequestFactCheck).toHaveBeenCalledTimes(callsBeforeUnmount);
        });
    });
});
