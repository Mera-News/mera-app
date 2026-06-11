// Mock apollo-client BEFORE imports.
const mockQuery = jest.fn();
const mockMutate = jest.fn();
const mockCacheReset = jest.fn(async (..._a: any[]) => {});

jest.mock('@/lib/apollo-client', () => ({
    __esModule: true,
    default: {
        query: (...a: any[]) => mockQuery(...a),
        mutate: (...a: any[]) => mockMutate(...a),
        cache: { reset: (...a: any[]) => mockCacheReset(...a) },
    },
}));

jest.mock('@/lib/logger', () => ({
    __esModule: true,
    default: {
        captureException: jest.fn(),
        captureMessage: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
        debug: jest.fn(),
        info: jest.fn(),
    },
}));

import SourceService from '../source-service';
import logger from '@/lib/logger';

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function makePublicationSource(overrides: Record<string, unknown> = {}) {
    return {
        _id: 'src-1',
        publication_name: 'Test Publication',
        publication_url: 'https://example.com',
        feed_url: 'https://example.com/rss',
        type: 'rss',
        feed_language_code: 'en',
        detected_language_code: 'en',
        country_code: 'USA',
        country_name: 'United States',
        category: 'news',
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T00:00:00Z',
        is_active: true,
        ...overrides,
    };
}

function makeNewsPublisher(overrides: Record<string, unknown> = {}) {
    return {
        _id: 'pub-1',
        name: 'Test Publisher',
        website_url: 'https://example.com',
        country_code: 'USA',
        publicationSources: [],
        is_active: true,
        country_name: 'United States',
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T00:00:00Z',
        ...overrides,
    };
}

// ─────────────────────────────────────────────────────────────────────────────
// getPublicationSources
// ─────────────────────────────────────────────────────────────────────────────

describe('SourceService.getPublicationSources', () => {
    beforeEach(() => jest.clearAllMocks());

    it('returns publication sources on success', async () => {
        const sources = [makePublicationSource(), makePublicationSource({ _id: 'src-2' })];
        const serverResp = {
            publicationSources: sources,
            pageInfo: { endCursor: 'cursor-1', hasNextPage: true, pageSize: 20 },
        };
        mockQuery.mockResolvedValueOnce({ data: { publicationSources: serverResp } });

        const result = await SourceService.getPublicationSources();
        expect(result).toEqual(serverResp);
    });

    it('returns empty structure when data is null', async () => {
        mockQuery.mockResolvedValueOnce({ data: { publicationSources: null } });
        const result = await SourceService.getPublicationSources();
        expect(result.publicationSources).toEqual([]);
        expect(result.pageInfo.hasNextPage).toBe(false);
        expect(result.pageInfo.pageSize).toBe(20);
    });

    it('uses no-cache fetchPolicy', async () => {
        mockQuery.mockResolvedValueOnce({ data: { publicationSources: null } });
        await SourceService.getPublicationSources();
        expect(mockQuery).toHaveBeenCalledWith(
            expect.objectContaining({ fetchPolicy: 'no-cache' }),
        );
    });

    it('passes default first=20 when no options provided', async () => {
        mockQuery.mockResolvedValueOnce({ data: { publicationSources: null } });
        await SourceService.getPublicationSources();
        expect(mockQuery).toHaveBeenCalledWith(
            expect.objectContaining({ variables: expect.objectContaining({ first: 20 }) }),
        );
    });

    it('passes languageCode filter', async () => {
        mockQuery.mockResolvedValueOnce({ data: { publicationSources: null } });
        await SourceService.getPublicationSources({ languageCode: 'fr' });
        expect(mockQuery).toHaveBeenCalledWith(
            expect.objectContaining({ variables: expect.objectContaining({ languageCode: 'fr' }) }),
        );
    });

    it('passes countryCode filter', async () => {
        mockQuery.mockResolvedValueOnce({ data: { publicationSources: null } });
        await SourceService.getPublicationSources({ countryCode: 'FRA' });
        expect(mockQuery).toHaveBeenCalledWith(
            expect.objectContaining({ variables: expect.objectContaining({ countryCode: 'FRA' }) }),
        );
    });

    it('passes category filter', async () => {
        mockQuery.mockResolvedValueOnce({ data: { publicationSources: null } });
        await SourceService.getPublicationSources({ category: 'technology' });
        expect(mockQuery).toHaveBeenCalledWith(
            expect.objectContaining({ variables: expect.objectContaining({ category: 'technology' }) }),
        );
    });

    it('passes custom first and after', async () => {
        mockQuery.mockResolvedValueOnce({ data: { publicationSources: null } });
        await SourceService.getPublicationSources({ first: 10, after: 'cursor-x' });
        expect(mockQuery).toHaveBeenCalledWith(
            expect.objectContaining({
                variables: expect.objectContaining({ first: 10, after: 'cursor-x' }),
            }),
        );
    });

    it('fallback pageSize matches options.first', async () => {
        mockQuery.mockResolvedValueOnce({ data: { publicationSources: null } });
        const result = await SourceService.getPublicationSources({ first: 5 });
        expect(result.pageInfo.pageSize).toBe(5);
    });

    it('re-throws on error and logs captureException', async () => {
        const err = new Error('sources query failed');
        mockQuery.mockRejectedValueOnce(err);

        await expect(SourceService.getPublicationSources()).rejects.toThrow('sources query failed');
        expect((logger.captureException as jest.Mock)).toHaveBeenCalledWith(
            err,
            expect.objectContaining({
                tags: { service: 'source-service', method: 'getPublicationSources' },
            }),
        );
    });

    it('returns publicationSources on success even without pageInfo issues', async () => {
        const serverResp = {
            publicationSources: [makePublicationSource()],
            pageInfo: { endCursor: null, hasNextPage: false, pageSize: 20 },
        };
        mockQuery.mockResolvedValueOnce({ data: { publicationSources: serverResp } });
        const result = await SourceService.getPublicationSources({ countryCode: 'USA', languageCode: 'en' });
        expect(result.publicationSources).toHaveLength(1);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// getNewsPublishers
// ─────────────────────────────────────────────────────────────────────────────

describe('SourceService.getNewsPublishers', () => {
    beforeEach(() => jest.clearAllMocks());

    it('returns publishers on success', async () => {
        const publishers = [makeNewsPublisher(), makeNewsPublisher({ _id: 'pub-2' })];
        const serverResp = {
            newsPublishers: publishers,
            pageInfo: { endCursor: 'cursor-2', hasNextPage: false, pageSize: 20 },
        };
        mockQuery.mockResolvedValueOnce({ data: { newsPublishers: serverResp } });

        const result = await SourceService.getNewsPublishers();
        expect(result).toEqual(serverResp);
    });

    it('returns empty structure when data is null', async () => {
        mockQuery.mockResolvedValueOnce({ data: { newsPublishers: null } });
        const result = await SourceService.getNewsPublishers();
        expect(result.newsPublishers).toEqual([]);
        expect(result.pageInfo.hasNextPage).toBe(false);
        expect(result.pageInfo.pageSize).toBe(20);
    });

    it('uses no-cache fetchPolicy', async () => {
        mockQuery.mockResolvedValueOnce({ data: { newsPublishers: null } });
        await SourceService.getNewsPublishers();
        expect(mockQuery).toHaveBeenCalledWith(
            expect.objectContaining({ fetchPolicy: 'no-cache' }),
        );
    });

    it('passes default first=20', async () => {
        mockQuery.mockResolvedValueOnce({ data: { newsPublishers: null } });
        await SourceService.getNewsPublishers();
        expect(mockQuery).toHaveBeenCalledWith(
            expect.objectContaining({ variables: expect.objectContaining({ first: 20 }) }),
        );
    });

    it('passes countryCode filter', async () => {
        mockQuery.mockResolvedValueOnce({ data: { newsPublishers: null } });
        await SourceService.getNewsPublishers({ countryCode: 'GBR' });
        expect(mockQuery).toHaveBeenCalledWith(
            expect.objectContaining({ variables: expect.objectContaining({ countryCode: 'GBR' }) }),
        );
    });

    it('passes custom first and after', async () => {
        mockQuery.mockResolvedValueOnce({ data: { newsPublishers: null } });
        await SourceService.getNewsPublishers({ first: 5, after: 'page-2' });
        expect(mockQuery).toHaveBeenCalledWith(
            expect.objectContaining({
                variables: expect.objectContaining({ first: 5, after: 'page-2' }),
            }),
        );
    });

    it('fallback pageSize matches options.first', async () => {
        mockQuery.mockResolvedValueOnce({ data: { newsPublishers: null } });
        const result = await SourceService.getNewsPublishers({ first: 7 });
        expect(result.pageInfo.pageSize).toBe(7);
    });

    it('fallback endCursor is null', async () => {
        mockQuery.mockResolvedValueOnce({ data: { newsPublishers: null } });
        const result = await SourceService.getNewsPublishers();
        expect(result.pageInfo.endCursor).toBeNull();
    });

    it('re-throws on error and logs captureException', async () => {
        const err = new Error('publishers query failed');
        mockQuery.mockRejectedValueOnce(err);

        await expect(SourceService.getNewsPublishers()).rejects.toThrow('publishers query failed');
        expect((logger.captureException as jest.Mock)).toHaveBeenCalledWith(
            err,
            expect.objectContaining({
                tags: { service: 'source-service', method: 'getNewsPublishers' },
            }),
        );
    });

    it('passes undefined countryCode when not provided', async () => {
        mockQuery.mockResolvedValueOnce({ data: { newsPublishers: null } });
        await SourceService.getNewsPublishers();
        const call = (mockQuery as jest.Mock).mock.calls[0][0];
        expect(call.variables.countryCode).toBeUndefined();
    });
});
