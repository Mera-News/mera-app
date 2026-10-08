jest.mock('expo-router', () => ({ useFocusEffect: jest.fn() }));
// The reads and writes are not under test; their modules reach the database.
jest.mock('../browse-countries', () => ({}));
jest.mock('../suppressed-scopes', () => ({}));

import { deriveWorldPages } from '../world-pages';

const base = { browseCountries: [], suppressedScopeIds: [], storedOrder: null } as const;

describe('deriveWorldPages', () => {
    it('never makes a page from the device region: no location + region IN is World alone', () => {
        const pages = deriveWorldPages({ ...base, locations: [], deviceCountryAlpha2: 'IN' });
        expect(pages.map((p) => p.id)).toEqual(['world']);
    });

    it('makes pages from the reader’s own places and added countries', () => {
        const pages = deriveWorldPages({
            ...base,
            locations: [{ city: 'utrecht', region: null, countryCode: 'NL', role: 'home', weight: 0.9 }],
            deviceCountryAlpha2: 'IN',
            browseCountries: ['DE'],
        });
        expect(pages.map((p) => p.id)).toEqual(['world', 'country:NL', 'country:DE']);
        expect(pages.find((p) => p.id === 'country:IN')).toBeUndefined();
    });
});
