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

import {
    searchPlaces,
    PLACE_SEARCH_MIN_CHARS,
    PLACE_CANDIDATE_LIMIT,
    lookupPlace,
    blocFor,
} from '../place-service';
import logger from '@/lib/logger';
import countries from 'i18n-iso-countries';

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


// ---------------------------------------------------------------------------
// lookupPlace
// ---------------------------------------------------------------------------

describe('lookupPlace', () => {
    beforeEach(() => jest.clearAllMocks());

    const rows = (...places: Record<string, unknown>[]) =>
        mockQuery.mockResolvedValueOnce({ data: { placeSearch: places } });

    it('returns up to three candidates IN SERVER ORDER, never re-sorted', async () => {
        // The server's population ranking is the only ranking signal there is;
        // re-sorting on a client-side heuristic would silently degrade it.
        rows(
            makePlace({ _id: 'a', city: 'Springfield', countryCode: 'US', population: 900 }),
            makePlace({ _id: 'b', city: 'Springfield', countryCode: 'GB', population: 800 }),
            makePlace({ _id: 'c', city: 'Springfield', countryCode: 'AU', population: 700 }),
            makePlace({ _id: 'd', city: 'Springfield', countryCode: 'CA', population: 600 }),
        );

        const out = await lookupPlace('Springfield');

        expect(out.status).toBe('resolved');
        if (out.status !== 'resolved') throw new Error('unreachable');
        expect(out.places).toHaveLength(PLACE_CANDIDATE_LIMIT);
        expect(out.places.map((p) => p.countryCode)).toEqual(['US', 'GB', 'AU']);
    });

    it('never collapses a failed round trip into no_match', async () => {
        // The conflation this union exists to prevent: "there is no such
        // place" and "we could not reach the server" need different words,
        // and only one is worth retrying.
        mockQuery.mockRejectedValueOnce(new Error('network down'));
        expect(await lookupPlace('Amsterdam')).toEqual({ status: 'unavailable' });
    });

    it('reports a genuine zero-result as no_match, carrying the query', async () => {
        rows();
        expect(await lookupPlace('Zzzzyx')).toEqual({ status: 'no_match', query: 'Zzzzyx' });
    });

    it('reports a short query as too_short and issues NO network call', async () => {
        // searchPlaces reports this as an empty SUCCESS, indistinguishable
        // from a real zero-result unless lookupPlace checks the length itself.
        const out = await lookupPlace('A');
        expect(out).toEqual({ status: 'too_short', minChars: PLACE_SEARCH_MIN_CHARS });
        expect(mockQuery).not.toHaveBeenCalled();
    });

    it('countryHint FILTERS rather than picking a winner', async () => {
        rows(
            makePlace({ city: 'Springfield', countryCode: 'US' }),
            makePlace({ city: 'Springfield', countryCode: 'GB' }),
        );
        const out = await lookupPlace('Springfield', 'gb');
        if (out.status !== 'resolved') throw new Error('unreachable');
        expect(out.places).toHaveLength(1);
        expect(out.places[0].countryCode).toBe('GB');
    });

    it('a hint matching nothing is no_match, never a fall-through to another country', async () => {
        rows(makePlace({ city: 'Springfield', countryCode: 'US' }));
        expect((await lookupPlace('Springfield', 'FR')).status).toBe('no_match');
    });

    it('maps the server row onto the harness field names', async () => {
        rows(makePlace({ city: 'Amsterdam', region: 'North Holland', countryCode: 'NL' }));
        const out = await lookupPlace('Amsterdam');
        if (out.status !== 'resolved') throw new Error('unreachable');
        expect(out.places[0]).toEqual({
            locality: 'Amsterdam',
            admin1: 'North Holland',
            countryCode: 'NL',
            // 'alias' form, matching country-utils' existing convention.
            countryName: 'The Netherlands',
            bloc: 'EU',
        });
        // Never populated here: the server has no neighbourhood data, so
        // setting it would mean inventing one.
        expect(out.places[0].neighbourhood).toBeUndefined();
    });

    it('resolves countryName from the ALPHA-2 code, not the bare code echoed back', async () => {
        // country-utils.getCountryName takes ALPHA-3 and falls back to the
        // input, so passing an alpha-2 there yields "NL" and looks like it
        // worked.
        rows(makePlace({ countryCode: 'DE' }));
        const out = await lookupPlace('Berlin');
        if (out.status !== 'resolved') throw new Error('unreachable');
        expect(out.places[0].countryName).toBe('Germany');
        expect(out.places[0].countryName).not.toBe('DE');
    });

    it('adds no second captureException — searchPlaces already reported it', async () => {
        mockQuery.mockRejectedValueOnce(new Error('boom'));
        await lookupPlace('Amsterdam');
        expect(logger.captureException).toHaveBeenCalledTimes(1);
    });

    it('a null region survives as admin1 null', async () => {
        rows(makePlace({ region: null, countryCode: 'SG' }));
        const out = await lookupPlace('Singapore');
        if (out.status !== 'resolved') throw new Error('unreachable');
        expect(out.places[0].admin1).toBeNull();
    });
});

describe('blocFor', () => {
    it('resolves EVERY ISO alpha-2 code to a non-null bloc', () => {
        // The map's self-policing check. ISO's list is a strict superset of
        // anything placeSearch can return (the places collection is
        // GeoNames-seeded and GeoNames uses alpha-2), and it is maintained by
        // the library rather than by this repo — so a code added upstream
        // fails here by name instead of returning null into an agent prompt.
        const codes = Object.keys(countries.getAlpha2Codes());
        expect(codes.length).toBeGreaterThan(200); // not a vacuous scan
        const unmapped = codes.filter((c) => blocFor(c) === null);
        expect(unmapped).toEqual([]);
    });

    it('lets the four NAMED blocs win over the continent for their members', () => {
        expect(blocFor('DE')).toBe('EU');   // not 'Europe'
        expect(blocFor('GB')).toBe('UK');
        expect(blocFor('NO')).toBe('EEA');
        expect(blocFor('CH')).toBe('EFTA');
        expect(blocFor('RS')).toBe('Europe');
    });

    it('pins the transcontinental judgement calls', () => {
        // Each of these reaches the agent's prompt as fact, so they are
        // decisions, not defaults.
        expect(blocFor('RU')).toBe('Europe');
        expect(blocFor('TR')).toBe('Asia');
        expect(blocFor('CY')).toBe('EU');      // EU membership wins
        expect(blocFor('EG')).toBe('Africa');
        expect(blocFor('KZ')).toBe('Asia');
        expect(blocFor('AZ')).toBe('Asia');
        expect(blocFor('GE')).toBe('Asia');
        expect(blocFor('AM')).toBe('Asia');
    });

    it('gives the Antarctic territories their own value rather than null', () => {
        for (const c of ['AQ', 'BV', 'GS', 'HM', 'TF']) {
            expect(blocFor(c)).toBe('Antarctica');
        }
    });

    it('is case-insensitive and null only for a code ISO does not know', () => {
        expect(blocFor('nl')).toBe('EU');
        expect(blocFor('ZZ')).toBeNull();
        expect(blocFor('')).toBeNull();
    });
});
