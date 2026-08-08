// Mock apollo-client BEFORE imports (same pattern as lib/__tests__/source-service.test.ts).
const mockQuery = jest.fn();
jest.mock('@/lib/apollo-client', () => ({
    __esModule: true,
    default: { query: (...a: any[]) => mockQuery(...a) },
}));

const mockCaptureException = jest.fn();
const mockAddBreadcrumb = jest.fn();
jest.mock('@/lib/logger', () => ({
    __esModule: true,
    default: {
        captureException: (...a: any[]) => mockCaptureException(...a),
        addBreadcrumb: (...a: any[]) => mockAddBreadcrumb(...a),
    },
}));

const mockIsNotSubscribedError = jest.fn();
jest.mock('@/lib/subscription/not-subscribed-error', () => ({
    isNotSubscribedError: (...a: any[]) => mockIsNotSubscribedError(...a),
}));

import {
    SEARCH_NEWS_MAX_RESULTS,
    SEARCH_NEWS_MIN_QUERY_LENGTH,
    searchNews,
} from '../search-news-service';

const makeHit = (overrides: Record<string, unknown> = {}) => ({
    _id: 'hit-1',
    title_en: 'A headline',
    image_url: 'https://example.com/x.jpg',
    publication_name: 'Example Times',
    country_code: 'US',
    pubDate: '2026-08-07T00:00:00.000Z',
    score: 0.87,
    ...overrides,
});

beforeEach(() => {
    jest.clearAllMocks();
    mockIsNotSubscribedError.mockReturnValue(false);
});

describe('searchNews', () => {
    it('short-circuits below the minimum query length without calling the server', async () => {
        const result = await searchNews('a');
        expect(result).toEqual({ ok: true, hits: [] });
        expect(mockQuery).not.toHaveBeenCalled();
    });

    it('short-circuits an all-whitespace query', async () => {
        const result = await searchNews('   ');
        expect(result).toEqual({ ok: true, hits: [] });
        expect(mockQuery).not.toHaveBeenCalled();
    });

    it('accepts exactly the minimum length', async () => {
        expect(SEARCH_NEWS_MIN_QUERY_LENGTH).toBe(2);
        mockQuery.mockResolvedValueOnce({ data: { searchNews: [] } });
        const result = await searchNews('ab');
        expect(result).toEqual({ ok: true, hits: [] });
        expect(mockQuery).toHaveBeenCalledTimes(1);
    });

    it('trims the query and passes the default limit', async () => {
        mockQuery.mockResolvedValueOnce({ data: { searchNews: [] } });
        await searchNews('  modi india  ');
        expect(mockQuery).toHaveBeenCalledWith(
            expect.objectContaining({
                variables: { query: 'modi india', limit: SEARCH_NEWS_MAX_RESULTS },
                fetchPolicy: 'no-cache',
            }),
        );
    });

    it('forwards a custom limit', async () => {
        mockQuery.mockResolvedValueOnce({ data: { searchNews: [] } });
        await searchNews('modi', 5);
        expect(mockQuery).toHaveBeenCalledWith(
            expect.objectContaining({ variables: { query: 'modi', limit: 5 } }),
        );
    });

    it('returns the hits from a successful response', async () => {
        const hits = [makeHit(), makeHit({ _id: 'hit-2' })];
        mockQuery.mockResolvedValueOnce({ data: { searchNews: hits } });
        const result = await searchNews('modi india');
        expect(result).toEqual({ ok: true, hits });
    });

    it('falls back to an empty array when the response carries no data', async () => {
        mockQuery.mockResolvedValueOnce({ data: null });
        const result = await searchNews('modi india');
        expect(result).toEqual({ ok: true, hits: [] });
    });

    it('classifies a 402/not-subscribed failure without reporting to Sentry', async () => {
        mockIsNotSubscribedError.mockReturnValue(true);
        mockQuery.mockRejectedValueOnce(new Error('PAYMENT_REQUIRED'));
        const result = await searchNews('modi india');
        expect(result).toEqual({ ok: false, kind: 'not-subscribed' });
        expect(mockAddBreadcrumb).toHaveBeenCalledTimes(1);
        expect(mockCaptureException).not.toHaveBeenCalled();
    });

    it('classifies any other failure as unknown and reports it', async () => {
        mockIsNotSubscribedError.mockReturnValue(false);
        const error = new Error('network down');
        mockQuery.mockRejectedValueOnce(error);
        const result = await searchNews('modi india');
        expect(result).toEqual({ ok: false, kind: 'unknown' });
        expect(mockCaptureException).toHaveBeenCalledWith(
            error,
            expect.objectContaining({ tags: { service: 'news-search-service', method: 'searchNews' } }),
        );
        expect(mockAddBreadcrumb).not.toHaveBeenCalled();
    });
});
