import {
    alpha2ToAlpha3,
    deriveExploreScopes,
    MAX_SCOPES,
    type ScopeLocationInput,
} from '../scopes';

const loc = (over: Partial<ScopeLocationInput>): ScopeLocationInput => ({
    city: null,
    region: null,
    countryCode: 'US',
    weight: 0.5,
    ...over,
});

describe('alpha2ToAlpha3', () => {
    it('maps common alpha-2 codes to alpha-3', () => {
        expect(alpha2ToAlpha3('US')).toBe('USA');
        expect(alpha2ToAlpha3('in')).toBe('IND');
        expect(alpha2ToAlpha3(' gb ')).toBe('GBR');
    });

    it('returns null for empty/garbage', () => {
        expect(alpha2ToAlpha3('')).toBeNull();
        expect(alpha2ToAlpha3(null)).toBeNull();
        expect(alpha2ToAlpha3('ZZ')).toBeNull();
    });
});

describe('deriveExploreScopes', () => {
    it('is Top stories + World only with no locations and no device country', () => {
        const scopes = deriveExploreScopes([], null);
        expect(scopes.map((s) => s.id)).toEqual(['top-stories', 'world']);
        expect(scopes[0]).toMatchObject({ kind: 'top', countryCodeAlpha3: null });
        expect(scopes[1]).toMatchObject({ kind: 'world', countryCodeAlpha3: null });
    });

    it('promotes the device country to "home" (2nd chip, ahead of World) when there are no locations', () => {
        const scopes = deriveExploreScopes([], 'US');
        expect(scopes.map((s) => s.id)).toEqual(['top-stories', 'country:USA', 'world']);
        expect(scopes[1]).toMatchObject({ kind: 'country', countryCodeAlpha3: 'USA', countryCodeAlpha2: 'US' });
    });

    it('falls back to the highest-weight location country as "home" when the device country is unmappable', () => {
        const scopes = deriveExploreScopes(
            [
                loc({ city: 'paris', countryCode: 'FR', weight: 0.95 }),
                loc({ city: 'tokyo', countryCode: 'JP', weight: 0.4 }),
            ],
            'ZZ', // unmappable
        );
        expect(scopes.map((s) => s.id)).toEqual(['top-stories', 'country:FRA', 'world', 'country:JPN']);
    });

    it('derives only a country scope from a location with a city (city/region chips removed)', () => {
        const scopes = deriveExploreScopes([loc({ city: 'new delhi', region: 'delhi', countryCode: 'IN' })], null);
        expect(scopes.map((s) => s.id)).toEqual(['top-stories', 'country:IND', 'world']);
        expect(scopes.every((s) => s.kind !== 'city' && s.kind !== 'region')).toBe(true);
        const country = scopes.find((s) => s.kind === 'country')!;
        expect(country).toMatchObject({ label: 'India', icon: 'flag', countryCodeAlpha3: 'IND' });
    });

    it('derives only a country scope from a location with a region but no city', () => {
        const scopes = deriveExploreScopes([loc({ region: 'bavaria', countryCode: 'DE' })], null);
        expect(scopes.map((s) => s.id)).toEqual(['top-stories', 'country:DEU', 'world']);
    });

    it('dedupes the home country from the location-derived tail (device country matches a location)', () => {
        const scopes = deriveExploreScopes(
            [
                loc({ city: 'mumbai', countryCode: 'IN', weight: 0.9 }),
                loc({ city: 'pune', countryCode: 'IN', weight: 0.8 }),
            ],
            'IN',
        );
        // top + a single shared home/country scope + world (no duplicate from
        // the 2nd location or from home appearing again in the tail).
        expect(scopes.map((s) => s.id)).toEqual(['top-stories', 'country:IND', 'world']);
    });

    it('preserves weight-desc order for the non-home location tail', () => {
        const scopes = deriveExploreScopes(
            [
                loc({ city: 'paris', countryCode: 'FR', weight: 0.95 }),
                loc({ city: 'tokyo', countryCode: 'JP', weight: 0.4 }),
                loc({ city: 'berlin', countryCode: 'DE', weight: 0.2 }),
            ],
            'US', // device country resolves home independently of the locations
        );
        expect(scopes.map((s) => s.id)).toEqual([
            'top-stories',
            'country:USA',
            'world',
            'country:FRA',
            'country:JPN',
            'country:DEU',
        ]);
    });

    it('caps at MAX_SCOPES, always keeping Top stories/home/World and dropping the lowest-weight tail', () => {
        const scopes = deriveExploreScopes(
            [
                loc({ city: 'a', countryCode: 'GB', weight: 0.9 }),
                loc({ city: 'b', countryCode: 'FR', weight: 0.8 }),
                loc({ city: 'c', countryCode: 'DE', weight: 0.7 }),
                loc({ city: 'd', countryCode: 'IT', weight: 0.6 }),
                loc({ city: 'e', countryCode: 'ES', weight: 0.5 }),
            ],
            'US', // home, distinct from every location — takes its own slot
        );
        expect(scopes).toHaveLength(MAX_SCOPES);
        expect(scopes[0].id).toBe('top-stories');
        expect(scopes[1].id).toBe('country:USA');
        expect(scopes[2].id).toBe('world');
        // Only the 3 highest-weight locations fit after top+home+world; the
        // lowest-weight ones (IT, ES) are dropped.
        expect(scopes.map((s) => s.id)).toEqual([
            'top-stories',
            'country:USA',
            'world',
            'country:GBR',
            'country:FRA',
            'country:DEU',
        ]);
        expect(scopes.some((s) => s.id === 'country:ITA')).toBe(false);
        expect(scopes.some((s) => s.id === 'country:ESP')).toBe(false);
    });

    it('skips locations with an unmappable country code', () => {
        const scopes = deriveExploreScopes([loc({ city: 'nowhere', countryCode: 'ZZ' })], null);
        expect(scopes.map((s) => s.id)).toEqual(['top-stories', 'world']);
    });
});
