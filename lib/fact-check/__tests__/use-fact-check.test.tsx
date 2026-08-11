// useFactCheck — the pure WatermelonDB observer that replaced the request/
// response hook. Properties worth a build over:
//
//   • it reacts to the RUNNER MUTATING A ROW IN PLACE, not just to rows being
//     added/removed. This is the one bug that would make the whole feature look
//     broken while every unit test built on a naive "push a new array" fake
//     still passed — see the file header of `use-fact-check.ts`. The fake query
//     below only exposes `observeWithColumns`, never `observe`, so a regression
//     back to `.observe()` fails EVERY test here with "not a function" rather
//     than silently passing;
//   • it never touches the network or mutates anything — there is no
//     `requestFactCheck` any more, only a read;
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
import { PROGRESS_DELAY_MS } from '../fact-check-state';
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
});
