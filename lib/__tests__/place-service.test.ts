// Mock apollo-client BEFORE importing the service (it loads apollo transitively).
const mockQuery = jest.fn();

jest.mock('@/lib/apollo-client', () => ({
    __esModule: true,
    default: {
        query: (...a: any[]) => mockQuery(...a),
    },
}));

jest.mock('@/lib/logger', () => ({
    __esModule: true,
    default: {
        captureException: jest.fn(),
        addBreadcrumb: jest.fn(),
        warn: jest.fn(),
    },
}));

import { searchPlaces, PLACE_SEARCH_MIN_CHARS } from '../place-service';
import logger from '@/lib/logger';

function makePlace(overrides: Record<string, unknown> = {}) {
    return {
        _id: 'p1',
        city: 'Amsterdam',
        region: 'North Holland',
        countryCode: 'NL',
        displayName: 'Amsterdam, North Holland, NL',
        normalized: 'amsterdam',
        population: 900000,
        ...overrides,
    };
}

describe('searchPlaces', () => {
    beforeEach(() => jest.clearAllMocks());

    it('returns the server rows mapped straight through (population-sorted order preserved)', async () => {
        const rows = [makePlace(), makePlace({ _id: 'p2', city: 'Amstelveen', population: 90000 })];
        mockQuery.mockResolvedValueOnce({ data: { placeSearch: rows } });

        const result = await searchPlaces('amster');

        expect(result).toEqual({ ok: true, places: rows });
        expect(mockQuery).toHaveBeenCalledTimes(1);
        const call = mockQuery.mock.calls[0][0];
        expect(call.variables).toEqual({ query: 'amster', limit: 8 });
        expect(call.fetchPolicy).toBe('no-cache');
    });

    it('trims the query and forwards a custom limit', async () => {
        mockQuery.mockResolvedValueOnce({ data: { placeSearch: [] } });
        await searchPlaces('  paris  ', 3);
        expect(mockQuery.mock.calls[0][0].variables).toEqual({ query: 'paris', limit: 3 });
    });

    it('short-circuits queries below the server minimum without a round-trip', async () => {
        const result = await searchPlaces('a');
        expect(result).toEqual({ ok: true, places: [] });
        expect(mockQuery).not.toHaveBeenCalled();
        expect(PLACE_SEARCH_MIN_CHARS).toBe(2);
    });

    it('degrades to an ok empty list (manual-entry fallback) when the collection is unseeded', async () => {
        mockQuery.mockResolvedValueOnce({ data: { placeSearch: [] } });
        expect(await searchPlaces('nowhere')).toEqual({ ok: true, places: [] });
    });

    it('returns ok:false and logs on a network error (distinguishable from an empty result)', async () => {
        mockQuery.mockRejectedValueOnce(new Error('boom'));
        const result = await searchPlaces('berlin');
        expect(result).toEqual({ ok: false });
        expect(logger.captureException).toHaveBeenCalled();
    });

    it('tolerates a null data payload', async () => {
        mockQuery.mockResolvedValueOnce({ data: null });
        expect(await searchPlaces('tokyo')).toEqual({ ok: true, places: [] });
    });
});
