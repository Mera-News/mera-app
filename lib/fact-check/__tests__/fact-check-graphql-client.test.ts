// fact-check-graphql-client — the SINGLE `factCheck(articleId)` query this
// wave codes against, verbatim per the SDL agent S1 is building. No mutation:
// the query itself is documented to insert-and-enqueue on first ask, so this
// file's tests pin `no-cache` (a poll that reads its own previous answer out
// of the Apollo cache never terminates) and the persist-on-every-call
// contract `requestFactCheck` layers on top.

const mockQuery = jest.fn();
jest.mock('../../apollo-client', () => ({
    __esModule: true,
    default: {
        query: (...a: any[]) => mockQuery(...a),
    },
}));

// Bare (no inline implementation) so its inferred signature keeps a rest
// parameter — the wrapper below spreads a variable-length args array into it,
// which a fixed-arity mock (e.g. `jest.fn(() => ...)`) can't accept.
const mockUpsertFactCheck = jest.fn();
const mockListFactChecksByStatus = jest.fn();
jest.mock('../../database/services/fact-check-record-service', () => ({
    upsertFactCheck: (...a: any[]) => mockUpsertFactCheck(...a),
    listFactChecksByStatus: (...a: any[]) => mockListFactChecksByStatus(...a),
}));

jest.mock('../../logger', () => ({
    __esModule: true,
    default: { captureException: jest.fn() },
}));

// `mirrorArticleFactCheck` reads the Mera Protocol switch. Mocked rather than
// hydrated: the real store pulls in the settings table, and the only thing
// under test here is that the switch is OBEYED.
let mockFactCheckEnabled = true;
jest.mock('../../stores/mera-protocol-store', () => ({
    useMeraProtocolStore: {
        getState: () => ({ factCheckEnabled: mockFactCheckEnabled }),
    },
}));

import {
    fetchFactCheck,
    mirrorArticleFactCheck,
    reconcileStoredFactChecks,
    requestFactCheck,
} from '../fact-check-graphql-client';

const TERMINAL_ROW = {
    _id: 'fc1',
    status: 'complete',
    verdict: 'supported',
    summary: 'Two outlets confirm.',
    checkedBy: [],
    checkedByStatus: 'searched',
    citations: [],
    claims: [],
    articleTitle: 'A headline',
};

const PENDING_ROW = {
    _id: 'fc1',
    status: 'pending',
    verdict: null,
    summary: null,
    checkedBy: [],
    checkedByStatus: undefined,
    citations: [],
    claims: [],
};

describe('fetchFactCheck', () => {
    beforeEach(() => jest.clearAllMocks());

    it('sends the article id, no-cache, and reports a terminal row as terminal', async () => {
        mockQuery.mockResolvedValue({ data: { factCheck: TERMINAL_ROW } });
        const outcome = await fetchFactCheck('a1');
        expect(outcome).toEqual({ terminal: true, row: TERMINAL_ROW });

        const args = mockQuery.mock.calls[0][0];
        expect(args.variables).toEqual({ articleId: 'a1' });
        expect(args.fetchPolicy).toBe('no-cache');
    });

    it('reports a pending/in-flight row as NOT terminal', async () => {
        mockQuery.mockResolvedValue({ data: { factCheck: PENDING_ROW } });
        const outcome = await fetchFactCheck('a1');
        expect(outcome).toEqual({ terminal: false, row: PENDING_ROW });
    });

    it('treats a null row (nobody has asked, or the resolver echoed nothing back yet) as not terminal', async () => {
        mockQuery.mockResolvedValue({ data: { factCheck: null } });
        expect(await fetchFactCheck('a1')).toEqual({ terminal: false, row: null });
    });

    it('treats absent data the same as a null row', async () => {
        mockQuery.mockResolvedValue({ data: undefined });
        expect(await fetchFactCheck('a1')).toEqual({ terminal: false, row: null });
    });

    it('propagates a transport/GraphQL failure to the caller — this is the raw call, callers decide how to degrade', async () => {
        mockQuery.mockRejectedValue(new Error('boom'));
        await expect(fetchFactCheck('a1')).rejects.toThrow('boom');
    });
});

describe('requestFactCheck', () => {
    beforeEach(() => jest.clearAllMocks());

    it('persists a terminal row into the LEGACY WHOLE-ARTICLE slot (claimKey omitted)', async () => {
        mockQuery.mockResolvedValue({ data: { factCheck: TERMINAL_ROW } });
        const outcome = await requestFactCheck('a1', 'Fallback title');
        expect(outcome.terminal).toBe(true);

        expect(mockUpsertFactCheck).toHaveBeenCalledTimes(1);
        const input = mockUpsertFactCheck.mock.calls[0][0];
        expect(input.articleId).toBe('a1');
        expect(input.status).toBe('complete');
        expect(input.verdict).toBe('supported');
        expect(input.payload).toEqual(TERMINAL_ROW);
        // No claimKey at all — the v52 "legacy whole-article" slot a server
        // (whole-article) check belongs in, never a per-claim keyed slot.
        expect(input).not.toHaveProperty('claimKey');
        // The server's own title wins over the caller-supplied fallback.
        expect(input.articleTitle).toBe('A headline');
    });

    it('falls back to the caller-supplied title when the server row has none', async () => {
        mockQuery.mockResolvedValue({
            data: { factCheck: { ...TERMINAL_ROW, articleTitle: null } },
        });
        await requestFactCheck('a1', 'Fallback title');
        expect(mockUpsertFactCheck.mock.calls[0][0].articleTitle).toBe('Fallback title');
    });

    it('persists a pending marker even when the server echoes no row at all', async () => {
        mockQuery.mockResolvedValue({ data: { factCheck: null } });
        const outcome = await requestFactCheck('a1', 'A headline');
        expect(outcome).toEqual({ terminal: false, row: null });

        expect(mockUpsertFactCheck).toHaveBeenCalledTimes(1);
        const input = mockUpsertFactCheck.mock.calls[0][0];
        expect(input.status).toBe('pending');
        expect(input.payload).toBeNull();
        expect(input.articleTitle).toBe('A headline');
    });

    it('degrades a request failure to "not yet confirmed" rather than throwing — every caller\'s honest response to a failed poll is "try again", not a crash', async () => {
        mockQuery.mockRejectedValue(new Error('network blip'));
        await expect(requestFactCheck('a1')).resolves.toEqual({ terminal: false, row: null });
        expect(mockUpsertFactCheck).not.toHaveBeenCalled();
    });

    it('is idempotent: calling it again for an already-terminal article just re-confirms the same row', async () => {
        mockQuery.mockResolvedValue({ data: { factCheck: TERMINAL_ROW } });
        await requestFactCheck('a1');
        await requestFactCheck('a1');
        expect(mockQuery).toHaveBeenCalledTimes(2);
        expect(mockUpsertFactCheck).toHaveBeenCalledTimes(2);
        expect(mockUpsertFactCheck.mock.calls[0][0].status).toBe('complete');
        expect(mockUpsertFactCheck.mock.calls[1][0].status).toBe('complete');
    });
});

// reconcileStoredFactChecks — the Dashboard-list sweep this pivot adds so a
// row nobody is actively watching (the reader left the article, or the poll
// in useFactCheck gave up at its ceiling) still has a path back to a terminal
// answer. Without it, r14 P2b's bug ("a completed check was stuck forever")
// recreates itself now that the check is server-side again.
describe('reconcileStoredFactChecks', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        mockListFactChecksByStatus.mockResolvedValue([]);
    });

    it('reads pending, running and failed rows, and re-asks the server for each', async () => {
        mockListFactChecksByStatus.mockImplementation((status: string) => {
            if (status === 'pending') return Promise.resolve([{ articleId: 'a1', articleTitle: 'A' }]);
            if (status === 'running') return Promise.resolve([{ articleId: 'a2', articleTitle: 'B' }]);
            if (status === 'failed') return Promise.resolve([{ articleId: 'a3', articleTitle: 'C' }]);
            return Promise.resolve([]);
        });
        mockQuery.mockResolvedValue({ data: { factCheck: PENDING_ROW } });

        await reconcileStoredFactChecks();

        expect(mockListFactChecksByStatus).toHaveBeenCalledWith('pending', expect.any(Number));
        expect(mockListFactChecksByStatus).toHaveBeenCalledWith('running', expect.any(Number));
        expect(mockListFactChecksByStatus).toHaveBeenCalledWith('failed', expect.any(Number));
        // One re-ask per row — this is `requestFactCheck` under the hood, so
        // each one also upserts.
        expect(mockQuery).toHaveBeenCalledTimes(3);
        expect(mockUpsertFactCheck).toHaveBeenCalledTimes(3);
    });

    it('never reads a terminal status — a settled table costs zero requests', async () => {
        await reconcileStoredFactChecks();
        expect(mockListFactChecksByStatus).not.toHaveBeenCalledWith('complete', expect.anything());
        expect(mockListFactChecksByStatus).not.toHaveBeenCalledWith('blocked', expect.anything());
    });

    it('is bounded across ALL statuses combined, not per status — the same cap r14 P2b used for this shape of problem', async () => {
        const many = (n: number, articleId: string) =>
            Array.from({ length: n }, (_, i) => ({ articleId: `${articleId}${i}`, articleTitle: 't' }));
        mockListFactChecksByStatus.mockImplementation((status: string, limit: number) => {
            if (status === 'pending') return Promise.resolve(many(Math.min(limit, 15), 'p'));
            if (status === 'running') return Promise.resolve(many(Math.min(limit, 15), 'r'));
            return Promise.resolve(many(Math.min(limit, 15), 'f'));
        });
        mockQuery.mockResolvedValue({ data: { factCheck: PENDING_ROW } });

        await reconcileStoredFactChecks();

        // 15 from 'pending' exhausts most of the 20-row cap; 'running' gets
        // whatever is left, 'failed' gets none — total re-asks never exceed 20.
        expect(mockQuery.mock.calls.length).toBeLessThanOrEqual(20);
    });

    it('one bad row does not stop the sweep for the rows after it', async () => {
        mockListFactChecksByStatus.mockImplementation((status: string) => {
            if (status === 'pending') {
                return Promise.resolve([
                    { articleId: 'bad', articleTitle: 'Bad' },
                    { articleId: 'good', articleTitle: 'Good' },
                ]);
            }
            return Promise.resolve([]);
        });
        // requestFactCheck itself never throws (it catches internally) — this
        // pins that the sweep survives even if that contract were ever broken.
        mockQuery
            .mockRejectedValueOnce(new Error('boom'))
            .mockResolvedValueOnce({ data: { factCheck: TERMINAL_ROW } });

        await expect(reconcileStoredFactChecks()).resolves.toBeUndefined();
        expect(mockQuery).toHaveBeenCalledTimes(2);
    });
});

// ===========================================================================
// mirrorArticleFactCheck — the cross-user visibility fix.
//
// Checks are cached server-side and keyed on the ARTICLE, holding no user
// identity, so the cache was always cross-user — but `useFactCheck` reports
// `absent` (and the panel renders nothing) when the LOCAL table has no row, so
// only the device that ASKED ever saw the answer. User A paid for the check,
// user B opened the same article and saw nothing. This lands the row that
// arrived attached to `articleById`, WITHOUT a request of its own.
// ===========================================================================
describe('mirrorArticleFactCheck', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        mockFactCheckEnabled = true;
    });

    it('writes the local row so the existing panel can render it', async () => {
        await expect(mirrorArticleFactCheck('a1', TERMINAL_ROW as never)).resolves.toBe(true);

        expect(mockUpsertFactCheck).toHaveBeenCalledTimes(1);
        expect(mockUpsertFactCheck).toHaveBeenCalledWith({
            articleId: 'a1',
            factCheckId: 'fc1',
            articleTitle: 'A headline',
            status: 'complete',
            verdict: 'supported',
            payload: TERMINAL_ROW,
        });
    });

    // The reason this is safe to run on every article open.
    it('makes NO network request', async () => {
        await mirrorArticleFactCheck('a1', TERMINAL_ROW as never);

        expect(mockQuery).not.toHaveBeenCalled();
    });

    it('writes nothing when the article carries no check', async () => {
        await expect(mirrorArticleFactCheck('a1', null)).resolves.toBe(false);
        await expect(mirrorArticleFactCheck('a1', undefined)).resolves.toBe(false);

        expect(mockUpsertFactCheck).not.toHaveBeenCalled();
    });

    it('writes nothing without an article id', async () => {
        await expect(mirrorArticleFactCheck('', TERMINAL_ROW as never)).resolves.toBe(false);

        expect(mockUpsertFactCheck).not.toHaveBeenCalled();
    });

    // A reader who turned the feature off must not accumulate fact-check rows
    // on their device as a side effect of reading articles.
    it('writes nothing when factCheckEnabled is off', async () => {
        mockFactCheckEnabled = false;

        await expect(mirrorArticleFactCheck('a1', TERMINAL_ROW as never)).resolves.toBe(false);

        expect(mockUpsertFactCheck).not.toHaveBeenCalled();
    });

    it('falls back to the caller title only when the row has none', async () => {
        await mirrorArticleFactCheck('a1', PENDING_ROW as never, 'From the article');

        expect(mockUpsertFactCheck).toHaveBeenCalledWith(
            expect.objectContaining({ articleTitle: 'From the article' }),
        );
    });

    // A missing panel must never cost the reader the article.
    it('never throws when the local write fails', async () => {
        mockUpsertFactCheck.mockRejectedValueOnce(new Error('db closed'));

        await expect(mirrorArticleFactCheck('a1', TERMINAL_ROW as never)).resolves.toBe(false);
    });
});
