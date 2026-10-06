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
const mockGetFactCheckForClaim = jest.fn();
jest.mock('../../database/services/fact-check-record-service', () => ({
    upsertFactCheck: (...a: any[]) => mockUpsertFactCheck(...a),
    getFactCheckForClaim: (...a: any[]) => mockGetFactCheckForClaim(...a),
}));

// The settle detector. Mocked at the module: its own suite covers it, and this
// one asserts only that every store reaches it.
const mockNoteStored = jest.fn();
const mockRecordAsked = jest.fn();
const mockListAsked = jest.fn();
jest.mock('../fact-check-settled', () => ({
    noteFactCheckStored: (...a: any[]) => mockNoteStored(...a),
    recordFactCheckAsked: (...a: any[]) => mockRecordAsked(...a),
    listAskedFactChecks: (...a: any[]) => mockListAsked(...a),
}));

// Retention write — mocked both to keep the real service's SQLite-opening
// database import out of this suite and to assert the keep inputs.
const mockKeepArticleForFactCheck = jest.fn();
jest.mock('../../database/services/saved-article-suggestion-service', () => ({
    keepArticleForFactCheck: (...a: any[]) => mockKeepArticleForFactCheck(...a),
}));

jest.mock('../../logger', () => ({
    __esModule: true,
    default: { captureException: jest.fn() },
}));

import {
    fetchFactCheck,
    reconcileAskedFactChecks,
    requestFactCheck,
    stopAskedFactCheckPollerForTest,
} from '../fact-check-graphql-client';

afterEach(() => stopAskedFactCheckPollerForTest());

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

    // ── Retention: a fact-checked article is kept openable like a saved one ──

    it('passes a caller-supplied keep input through to the retention write verbatim', async () => {
        mockQuery.mockResolvedValue({ data: { factCheck: TERMINAL_ROW } });
        const keep = { articleId: 'a1', article: { _id: 'a1' } as never };

        await requestFactCheck('a1', 'Fallback title', keep);

        expect(mockKeepArticleForFactCheck).toHaveBeenCalledTimes(1);
        expect(mockKeepArticleForFactCheck).toHaveBeenCalledWith(keep);
    });

    it('degrades to the server row fields (title/url/publication) when no keep input is given', async () => {
        mockQuery.mockResolvedValue({
            data: {
                factCheck: {
                    ...TERMINAL_ROW,
                    articleUrl: 'https://example.com/a',
                    publicationName: 'The Paper',
                },
            },
        });

        await requestFactCheck('a1', 'Fallback title');

        expect(mockKeepArticleForFactCheck).toHaveBeenCalledWith({
            articleId: 'a1',
            title: 'A headline',
            articleUrl: 'https://example.com/a',
            publicationName: 'The Paper',
        });
    });

    it('keeps a title-only degraded snapshot on the pending-stub (no row) branch', async () => {
        mockQuery.mockResolvedValue({ data: { factCheck: null } });

        await requestFactCheck('a1', 'A headline');

        expect(mockKeepArticleForFactCheck).toHaveBeenCalledWith({
            articleId: 'a1',
            title: 'A headline',
            articleUrl: null,
            publicationName: null,
        });
    });

    it('does not keep anything when the request itself failed', async () => {
        mockQuery.mockRejectedValue(new Error('network blip'));
        await requestFactCheck('a1');
        expect(mockKeepArticleForFactCheck).not.toHaveBeenCalled();
    });

    it('a failed keep never fails the ask or degrades the outcome', async () => {
        mockQuery.mockResolvedValue({ data: { factCheck: TERMINAL_ROW } });
        mockKeepArticleForFactCheck.mockRejectedValueOnce(new Error('db closed'));

        await expect(requestFactCheck('a1')).resolves.toEqual({
            terminal: true,
            row: TERMINAL_ROW,
        });
    });
});

// reconcileStoredFactChecks — the Dashboard-list sweep this pivot adds so a
// row nobody is actively watching (the reader left the article, or the poll
// in useFactCheck gave up at its ceiling) still has a path back to a terminal
// answer. Without it, r14 P2b's bug ("a completed check was stuck forever")
// recreates itself now that the check is server-side again.
// ===========================================================================
describe('the asked list and the one store', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        mockGetFactCheckForClaim.mockResolvedValue(null);
        mockListAsked.mockResolvedValue([]);
    });

    it('records the FIRST ask from this device, with the suggestion it came from', async () => {
        mockQuery.mockResolvedValue({ data: { factCheck: PENDING_ROW } });
        await requestFactCheck('a1', 'T', { articleId: 'a1', suggestion: { _id: 's1' } as never });
        expect(mockRecordAsked).toHaveBeenCalledWith({ articleId: 'a1', suggestionId: 's1', title: 'T' });
    });

    it('does not re-record when a local row already exists (a poll, not an ask)', async () => {
        mockGetFactCheckForClaim.mockResolvedValue({ status: 'pending' });
        mockQuery.mockResolvedValue({ data: { factCheck: TERMINAL_ROW } });
        await requestFactCheck('a1', 'T');
        expect(mockRecordAsked).not.toHaveBeenCalled();
        // ...and the store hands the previous status to the detector.
        expect(mockNoteStored).toHaveBeenCalledWith('a1', 'pending', TERMINAL_ROW);
    });

    it('an explicit tap on an unfinished row nobody here asked for records the ask', async () => {
        mockGetFactCheckForClaim.mockResolvedValue({ status: 'pending' });
        mockQuery.mockResolvedValue({ data: { factCheck: PENDING_ROW } });
        await requestFactCheck('a1', 'T', undefined, true);
        expect(mockRecordAsked).toHaveBeenCalledWith({ articleId: 'a1', suggestionId: null, title: 'T' });
    });

    it('the poll alone (no explicit flag) never records an ask on an unfinished row', async () => {
        mockGetFactCheckForClaim.mockResolvedValue({ status: 'pending' });
        mockQuery.mockResolvedValue({ data: { factCheck: PENDING_ROW } });
        await requestFactCheck('a1');
        expect(mockRecordAsked).not.toHaveBeenCalled();
    });

    it('an explicit tap on a settled row records nothing: there is nothing to wait for', async () => {
        mockGetFactCheckForClaim.mockResolvedValue({ status: 'complete' });
        mockQuery.mockResolvedValue({ data: { factCheck: TERMINAL_ROW } });
        await requestFactCheck('a1', 'T', undefined, true);
        expect(mockRecordAsked).not.toHaveBeenCalled();
    });

    it('re-reads ONLY asked checks, read-only, and counts the ones still waiting', async () => {
        mockListAsked.mockResolvedValue([
            { articleId: 'a1', suggestionId: null, title: 'A', askedAt: 1 },
            { articleId: 'a2', suggestionId: null, title: 'B', askedAt: 2 },
            { articleId: 'a3', suggestionId: null, title: 'C', askedAt: 3 },
        ]);
        mockQuery
            .mockResolvedValueOnce({ data: { cachedFactCheck: TERMINAL_ROW } })
            .mockResolvedValueOnce({ data: { cachedFactCheck: PENDING_ROW } })
            .mockResolvedValueOnce({ data: { cachedFactCheck: null } });
        const waiting = await reconcileAskedFactChecks();
        expect(waiting).toBe(2);
        expect(mockQuery).toHaveBeenCalledTimes(3);
        for (const [req] of mockQuery.mock.calls) {
            expect(req.query.definitions[0].name.value).toBe('GetCachedFactCheck');
        }
        // A server miss writes nothing: nothing to store, nothing billed.
        expect(mockUpsertFactCheck).toHaveBeenCalledTimes(2);
    });
});
