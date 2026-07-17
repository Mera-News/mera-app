import { articleMatchesScope, filterArticlesForScope } from '../geo-scope-filter';
import type { ExploreScope } from '../scopes';

const scope = (over: Partial<ExploreScope>): ExploreScope => ({
    id: 'x',
    kind: 'city',
    label: 'X',
    icon: 'location-city',
    countryCodeAlpha3: 'IND',
    ...over,
});

const worldScope: ExploreScope = { id: 'world', kind: 'world', label: '', icon: 'public', countryCodeAlpha3: null };
const countryScope: ExploreScope = {
    id: 'country:IND',
    kind: 'country',
    label: 'India',
    icon: 'flag',
    countryCodeAlpha3: 'IND',
};

describe('articleMatchesScope', () => {
    it('world and country scopes always match (no client geo filter)', () => {
        expect(articleMatchesScope(null, worldScope)).toBe(true);
        expect(articleMatchesScope(null, countryScope)).toBe(true);
        expect(articleMatchesScope([], countryScope)).toBe(true);
    });

    it('city scope matches on any tag city, case-insensitively', () => {
        const s = scope({ kind: 'city', city: 'mumbai' });
        expect(articleMatchesScope([{ city: 'Mumbai', region: 'MH', countryCode: 'IN' }], s)).toBe(true);
        expect(articleMatchesScope([{ city: 'delhi' }, { city: 'MUMBAI' }], s)).toBe(true);
        expect(articleMatchesScope([{ city: 'pune' }], s)).toBe(false);
    });

    it('region scope matches on any tag region, case-insensitively', () => {
        const s = scope({ kind: 'region', city: undefined, region: 'maharashtra' });
        expect(articleMatchesScope([{ region: 'Maharashtra' }], s)).toBe(true);
        expect(articleMatchesScope([{ region: 'gujarat' }], s)).toBe(false);
    });

    it('treats null / empty geo_tags as no-match for city/region (dormant tagging)', () => {
        const s = scope({ kind: 'city', city: 'mumbai' });
        expect(articleMatchesScope(null, s)).toBe(false);
        expect(articleMatchesScope(undefined, s)).toBe(false);
        expect(articleMatchesScope([], s)).toBe(false);
        expect(articleMatchesScope([{ city: null, region: null }], s)).toBe(false);
    });

    it('returns false when the scope place is missing', () => {
        expect(articleMatchesScope([{ city: 'mumbai' }], scope({ kind: 'city', city: undefined }))).toBe(false);
        expect(articleMatchesScope([{ region: 'mh' }], scope({ kind: 'region', region: undefined }))).toBe(false);
    });
});

describe('filterArticlesForScope', () => {
    const articles = [
        { _id: '1', geo_tags: [{ city: 'mumbai' }] },
        { _id: '2', geo_tags: [{ city: 'delhi' }] },
        { _id: '3', geo_tags: null },
        { _id: '4', geo_tags: [{ city: 'MUMBAI' }] },
    ];

    it('passes country/world scopes through untouched', () => {
        expect(filterArticlesForScope(articles, worldScope)).toHaveLength(4);
        expect(filterArticlesForScope(articles, countryScope)).toHaveLength(4);
    });

    it('keeps only the rows matching a city scope', () => {
        const kept = filterArticlesForScope(articles, scope({ kind: 'city', city: 'mumbai' }));
        expect(kept.map((a) => a._id)).toEqual(['1', '4']);
    });
});
