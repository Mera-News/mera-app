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
    it('always starts with World, even with no locations and no device country', () => {
        const scopes = deriveExploreScopes([], null);
        expect(scopes).toHaveLength(1);
        expect(scopes[0]).toMatchObject({ id: 'world', kind: 'world', countryCodeAlpha3: null });
    });

    it('adds the device country after World when there are no locations', () => {
        const scopes = deriveExploreScopes([], 'US');
        expect(scopes.map((s) => s.id)).toEqual(['world', 'country:USA']);
        expect(scopes[1]).toMatchObject({ kind: 'country', countryCodeAlpha3: 'USA', countryCodeAlpha2: 'US' });
    });

    it('derives only a country scope from a location with a city (city/region chips removed)', () => {
        const scopes = deriveExploreScopes([loc({ city: 'new delhi', region: 'delhi', countryCode: 'IN' })], null);
        expect(scopes.map((s) => s.id)).toEqual(['world', 'country:IND']);
        expect(scopes.every((s) => s.kind !== 'city' && s.kind !== 'region')).toBe(true);
        const country = scopes.find((s) => s.kind === 'country')!;
        expect(country).toMatchObject({ label: 'India', icon: 'flag', countryCodeAlpha3: 'IND' });
    });

    it('derives only a country scope from a location with a region but no city', () => {
        const scopes = deriveExploreScopes([loc({ region: 'bavaria', countryCode: 'DE' })], null);
        expect(scopes.map((s) => s.id)).toEqual(['world', 'country:DEU']);
    });

    it('dedupes the country scope across locations sharing a country and the device country', () => {
        const scopes = deriveExploreScopes(
            [
                loc({ city: 'mumbai', countryCode: 'IN', weight: 0.9 }),
                loc({ city: 'pune', countryCode: 'IN', weight: 0.8 }),
            ],
            'IN',
        );
        // world + a single shared country scope (no duplicate from the 2nd
        // location or the device country).
        expect(scopes.map((s) => s.id)).toEqual(['world', 'country:IND']);
    });

    it('preserves weight-desc location order (locations arrive pre-sorted)', () => {
        const scopes = deriveExploreScopes(
            [
                loc({ city: 'paris', countryCode: 'FR', weight: 0.95 }),
                loc({ city: 'tokyo', countryCode: 'JP', weight: 0.4 }),
            ],
            null,
        );
        const countryIds = scopes.filter((s) => s.kind === 'country').map((s) => s.id);
        expect(countryIds).toEqual(['country:FRA', 'country:JPN']);
    });

    it('caps at MAX_SCOPES, always keeping World and dropping the lowest-priority tail', () => {
        const scopes = deriveExploreScopes(
            [
                loc({ city: 'a', countryCode: 'US', weight: 0.9 }),
                loc({ city: 'b', countryCode: 'GB', weight: 0.8 }),
                loc({ city: 'c', countryCode: 'FR', weight: 0.7 }),
                loc({ city: 'd', countryCode: 'DE', weight: 0.6 }),
                loc({ city: 'e', countryCode: 'IT', weight: 0.5 }),
            ],
            'JP', // device country is lowest priority → should be dropped
        );
        expect(scopes).toHaveLength(MAX_SCOPES);
        expect(scopes[0].id).toBe('world');
        expect(scopes.some((s) => s.id === 'country:JPN')).toBe(false);
    });

    it('skips locations with an unmappable country code', () => {
        const scopes = deriveExploreScopes([loc({ city: 'nowhere', countryCode: 'ZZ' })], null);
        expect(scopes.map((s) => s.id)).toEqual(['world']);
    });
});
