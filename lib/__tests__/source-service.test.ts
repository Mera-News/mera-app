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
import { print } from 'graphql';
import {
    __clearPublisherSourceNames,
    knownSourceNamesForPublisher,
} from '@/lib/database/services/publisher-source-names';

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

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

// ─────────────────────────────────────────────────────────────────────────────
// searchPublishers (Item 8)
// ─────────────────────────────────────────────────────────────────────────────

function makePublisherSearchHit(overrides: Record<string, unknown> = {}) {
    return {
        _id: 'pub-1',
        name: 'Times of India',
        website_url: 'https://timesofindia.indiatimes.com',
        country_code: 'IND',
        country_name: 'India',
        matchingSources: [],
        ...overrides,
    };
}

describe('SourceService.searchPublishers', () => {
    beforeEach(() => jest.clearAllMocks());

    it('returns publishers on success', async () => {
        const hits = [makePublisherSearchHit(), makePublisherSearchHit({ _id: 'pub-2' })];
        const serverResp = {
            publishers: hits,
            pageInfo: { endCursor: 'cursor-1', hasNextPage: true, pageSize: 20 },
        };
        mockQuery.mockResolvedValueOnce({ data: { searchPublishers: serverResp } });

        const result = await SourceService.searchPublishers({ query: 'Times of India' });
        expect(result).toEqual(serverResp);
    });

    it('returns empty structure when data is null', async () => {
        mockQuery.mockResolvedValueOnce({ data: { searchPublishers: null } });
        const result = await SourceService.searchPublishers({ query: 'xx' });
        expect(result.publishers).toEqual([]);
        expect(result.pageInfo.hasNextPage).toBe(false);
        expect(result.pageInfo.pageSize).toBe(20);
    });

    it('uses no-cache fetchPolicy', async () => {
        mockQuery.mockResolvedValueOnce({ data: { searchPublishers: null } });
        await SourceService.searchPublishers({ query: 'xx' });
        expect(mockQuery).toHaveBeenCalledWith(
            expect.objectContaining({ fetchPolicy: 'no-cache' }),
        );
    });

    it('passes the query and default first=20', async () => {
        mockQuery.mockResolvedValueOnce({ data: { searchPublishers: null } });
        await SourceService.searchPublishers({ query: 'bbc' });
        expect(mockQuery).toHaveBeenCalledWith(
            expect.objectContaining({
                variables: expect.objectContaining({ query: 'bbc', first: 20 }),
            }),
        );
    });

    it('passes custom first and after', async () => {
        mockQuery.mockResolvedValueOnce({ data: { searchPublishers: null } });
        await SourceService.searchPublishers({ query: 'bbc', first: 5, after: 'cursor-x' });
        expect(mockQuery).toHaveBeenCalledWith(
            expect.objectContaining({
                variables: expect.objectContaining({ query: 'bbc', first: 5, after: 'cursor-x' }),
            }),
        );
    });

    it('fallback pageSize matches options.first', async () => {
        mockQuery.mockResolvedValueOnce({ data: { searchPublishers: null } });
        const result = await SourceService.searchPublishers({ query: 'bbc', first: 7 });
        expect(result.pageInfo.pageSize).toBe(7);
    });

    it('re-throws on error and logs captureException', async () => {
        const err = new Error('search query failed');
        mockQuery.mockRejectedValueOnce(err);

        await expect(SourceService.searchPublishers({ query: 'bbc' })).rejects.toThrow('search query failed');
        expect((logger.captureException as jest.Mock)).toHaveBeenCalledWith(
            err,
            expect.objectContaining({
                tags: { service: 'source-service', method: 'searchPublishers' },
            }),
        );
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// No feeds in the app: the publisher list carries source NAMES (they key
// more/fewer) and no feed URL; search results carry no feed URL either.
// ─────────────────────────────────────────────────────────────────────────────

describe('SourceService: publication shape, no feeds', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        mockQuery.mockReset();
        __clearPublisherSourceNames();
    });

    it('getNewsPublishers selects source names, never feed_url, and records the names', async () => {
        mockQuery.mockResolvedValueOnce({
            data: {
                newsPublishers: {
                    newsPublishers: [
                        makeNewsPublisher({
                            _id: 'p1',
                            publicationSources: [
                                { _id: 's1', publication_name: 'Times of India' },
                                { _id: 's2', publication_name: 'TOI Business' },
                            ],
                        }),
                    ],
                    pageInfo: { endCursor: null, hasNextPage: false, pageSize: 20 },
                },
            },
        });
        await SourceService.getNewsPublishers({ countryCode: 'IND' });
        const doc = print(mockQuery.mock.calls[0][0].query);
        expect(doc).toMatch(/publicationSources\s*\{[^}]*publication_name/);
        expect(doc).not.toContain('feed_url');
        expect(knownSourceNamesForPublisher('p1')).toEqual(['Times of India', 'TOI Business']);
    });

    it('searchPublishers selects no feed_url and records nothing (matchingSources is a filtered subset)', async () => {
        mockQuery.mockResolvedValueOnce({
            data: {
                searchPublishers: {
                    publishers: [{ _id: 'p2', name: 'X', matchingSources: [{ _id: 's', publication_name: 'X' }] }],
                    pageInfo: { endCursor: null, hasNextPage: false, pageSize: 20 },
                },
            },
        });
        await SourceService.searchPublishers({ query: 'xx' });
        expect(print(mockQuery.mock.calls[0][0].query)).not.toContain('feed_url');
        expect(knownSourceNamesForPublisher('p2')).toBeNull();
    });

    it('has no feed-list method any more', () => {
        expect((SourceService as unknown as Record<string, unknown>).getPublicationSources).toBeUndefined();
    });
});
