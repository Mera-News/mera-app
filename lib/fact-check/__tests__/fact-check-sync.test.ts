// fact-check-sync — the bounded, shared "is the stored row still true?" read.
//
// This module exists because of a real prod failure: a fact check that had
// COMPLETED server-side rendered "Still searching" indefinitely on the device.
// The Dashboard block and the fact-checks list read the local table and never
// asked the server anything, and the panel's own read wrote back
// fire-and-forget, so even a successful reconcile could lose the race against
// the next read.
//
// The properties that have to hold:
//   • a terminal row costs ZERO requests (opening the Dashboard is free);
//   • a non-terminal row costs EXACTLY ONE, and the result is AWAITED into the
//     table before the caller is told anything;
//   • a list pass reads only the unresolved rows, and is bounded;
//   • nothing here ever schedules a retry — the bound must be structural.

const mockGetFactCheck = jest.fn();
jest.mock('../fact-check-service', () => ({
    FactCheckService: {
        requestFactCheck: jest.fn(),
        getFactCheck: (...a: any[]) => mockGetFactCheck(...a),
    },
}));

// One shared fake table, so a write that does not land is observable.
let mockRows: Record<string, any> = {};

const mockUpsert = jest.fn(async (input: any) => {
    const prev = mockRows[input.articleId];
    mockRows[input.articleId] = {
        id: prev?.id ?? `row-${input.articleId}`,
        articleId: input.articleId,
        factCheckId: input.factCheckId,
        articleTitle: input.articleTitle ?? null,
        status: input.status,
        verdict: input.verdict ?? null,
        payload: input.payload,
        requestedAt: prev?.requestedAt ?? 1,
        resolvedAt: null,
    };
});

jest.mock('@/lib/database/services/fact-check-record-service', () => ({
    upsertFactCheck: (...a: any[]) => mockUpsert(...(a as [any])),
    getFactCheckForArticle: async (articleId: string) => mockRows[articleId] ?? null,
    listFactChecks: async () => Object.values(mockRows),
}));

jest.mock('@/lib/logger', () => ({
    __esModule: true,
    default: {
        captureException: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
        debug: jest.fn(),
        info: jest.fn(),
    },
}));

import {
    MAX_RECONCILE_PER_PASS,
    reconcileFactCheck,
    reconcileStoredFactChecks,
} from '../fact-check-sync';

const serverRow = (status: string, extra: Record<string, unknown> = {}) =>
    ({ _id: 'fc1', status, verdict: null, claims: [], citations: [], ...extra }) as any;

function seed(articleId: string, status: string, extra: Record<string, unknown> = {}) {
    mockRows[articleId] = {
        id: `row-${articleId}`,
        articleId,
        factCheckId: 'fc1',
        articleTitle: null,
        status,
        verdict: null,
        payload: { _id: 'fc1', status },
        requestedAt: 1,
        resolvedAt: null,
        ...extra,
    };
}

beforeEach(() => {
    jest.clearAllMocks();
    mockRows = {};
});

describe('reconcileFactCheck', () => {
    it('spends nothing when no row is stored — nobody asked on this device', async () => {
        const res = await reconcileFactCheck('a1');
        expect(res).toEqual({ stored: null, changed: false, failed: false });
        expect(mockGetFactCheck).not.toHaveBeenCalled();
    });

    it('spends nothing on an already-terminal row — it can never change again', async () => {
        seed('a1', 'complete', { verdict: 'supported' });
        const res = await reconcileFactCheck('a1');
        expect(res.changed).toBe(false);
        expect(res.stored?.status).toBe('complete');
        expect(mockGetFactCheck).not.toHaveBeenCalled();
    });

    // The prod case.
    it('advances a stored PENDING row when the server has since completed', async () => {
        seed('a1', 'pending');
        mockGetFactCheck.mockResolvedValue(serverRow('complete', { verdict: 'supported' }));

        const res = await reconcileFactCheck('a1');

        expect(mockGetFactCheck).toHaveBeenCalledTimes(1);
        expect(res.changed).toBe(true);
        expect(res.stored?.status).toBe('complete');
        // AWAITED, not fire-and-forget: the table is already correct by the time
        // the caller is told, because the other surfaces read the table.
        expect(mockRows.a1.status).toBe('complete');
        expect(mockRows.a1.verdict).toBe('supported');
    });

    it('reports failure and preserves the stored row when the read throws', async () => {
        seed('a1', 'pending');
        mockGetFactCheck.mockRejectedValue(new Error('offline'));

        const res = await reconcileFactCheck('a1');

        expect(res.failed).toBe(true);
        expect(res.changed).toBe(false);
        expect(res.stored?.status).toBe('pending');
        // Never throws — every caller is a render path.
        expect(mockRows.a1.status).toBe('pending');
    });

    it('leaves a still-unresolved row alone without reporting a failure', async () => {
        seed('a1', 'running');
        mockGetFactCheck.mockResolvedValue(serverRow('running'));

        const res = await reconcileFactCheck('a1');

        expect(res.failed).toBe(false);
        expect(res.changed).toBe(false);
        expect(res.stored?.status).toBe('running');
    });

    it('accepts a caller-supplied row and skips the extra table read', async () => {
        seed('a1', 'complete');
        const res = await reconcileFactCheck('a1', mockRows.a1);
        expect(res.stored?.status).toBe('complete');
        expect(mockGetFactCheck).not.toHaveBeenCalled();
    });

    it('does nothing without an article id', async () => {
        expect(await reconcileFactCheck(null)).toEqual({
            stored: null, changed: false, failed: false,
        });
        expect(mockGetFactCheck).not.toHaveBeenCalled();
    });
});

// ── The stranded-row case ───────────────────────────────────────────────────
// Users who asked for a fact check BEFORE the push was removed were told a
// notification was coming. It never will be. Nothing in the recovery path may
// depend on push delivery, on a token, or on notification permission — a row
// that has been sitting `pending` for days must resolve the moment any surface
// reads it. This is the whole safety net for those users, so it is pinned
// separately from the ordinary reconcile cases.
describe('a row left pending from before the push was removed', () => {
    it('resolves on the next read, with no push involvement whatsoever', async () => {
        seed('a1', 'pending', { requestedAt: 1 });
        mockGetFactCheck.mockResolvedValue(serverRow('complete', { verdict: 'supported' }));

        const res = await reconcileFactCheck('a1');

        expect(res.changed).toBe(true);
        expect(mockRows.a1.status).toBe('complete');
        expect(mockRows.a1.verdict).toBe('supported');
    });

    it('resolves through the list pass too — the Dashboard chip path', async () => {
        seed('a1', 'pending');
        seed('a2', 'running');
        mockGetFactCheck.mockResolvedValue(serverRow('complete', { verdict: 'mixed' }));

        expect(await reconcileStoredFactChecks()).toBe(2);
        expect(mockRows.a1.status).toBe('complete');
        expect(mockRows.a2.status).toBe('complete');
    });

    it('stays pending — never silently discarded — when the device is offline', async () => {
        seed('a1', 'pending');
        mockGetFactCheck.mockRejectedValue(new Error('offline'));

        await reconcileStoredFactChecks();

        // Still there, still pending, still retryable on the next read. A row
        // that vanished here would be unrecoverable: nothing else announces it.
        expect(mockRows.a1.status).toBe('pending');
    });
});

describe('reconcileStoredFactChecks', () => {
    it('reads ONLY the unresolved rows — a settled table is free', async () => {
        seed('a1', 'complete');
        seed('a2', 'blocked');
        seed('a3', 'pending');
        mockGetFactCheck.mockResolvedValue(serverRow('complete', { verdict: 'mixed' }));

        const changed = await reconcileStoredFactChecks();

        expect(mockGetFactCheck).toHaveBeenCalledTimes(1);
        expect(mockGetFactCheck).toHaveBeenCalledWith('a3');
        expect(changed).toBe(1);
        expect(mockRows.a3.status).toBe('complete');
    });

    it('costs zero requests when everything is already terminal', async () => {
        seed('a1', 'complete');
        seed('a2', 'blocked');
        expect(await reconcileStoredFactChecks()).toBe(0);
        expect(mockGetFactCheck).not.toHaveBeenCalled();
    });

    it('is bounded — a pathological table cannot fan out without limit', async () => {
        for (let i = 0; i < MAX_RECONCILE_PER_PASS + 15; i += 1) seed(`a${i}`, 'pending');
        mockGetFactCheck.mockResolvedValue(serverRow('running'));

        await reconcileStoredFactChecks();

        expect(mockGetFactCheck).toHaveBeenCalledTimes(MAX_RECONCILE_PER_PASS);
    });

    it('one failing row does not abort the pass', async () => {
        seed('a1', 'pending');
        seed('a2', 'pending');
        mockGetFactCheck
            .mockRejectedValueOnce(new Error('offline'))
            .mockResolvedValueOnce(serverRow('complete', { verdict: 'supported' }));

        const changed = await reconcileStoredFactChecks();

        expect(mockGetFactCheck).toHaveBeenCalledTimes(2);
        expect(changed).toBe(1);
    });
});
