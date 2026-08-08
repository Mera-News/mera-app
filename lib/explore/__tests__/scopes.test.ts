import {
    alpha2ToAlpha3,
    deriveExploreScopes,
    electPrimaryCountry,
    MAX_SCOPES,
    type ScopeLocationInput,
} from '../scopes';

// `locations` always arrives pre-sorted weight-desc (the location-service query
// sorts on weight), so fixtures below are written in that order.
const loc = (over: Partial<ScopeLocationInput>): ScopeLocationInput => ({
    city: null,
    region: null,
    countryCode: 'US',
    role: 'interest',
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

describe('electPrimaryCountry', () => {
    it('prefers the highest-weight role:"home" row over a heavier non-home row', () => {
        const primary = electPrimaryCountry(
            [
                loc({ city: 'paris', countryCode: 'FR', role: 'interest', weight: 0.95 }),
                loc({ city: 'mumbai', countryCode: 'IN', role: 'home', weight: 0.6 }),
                loc({ city: 'delhi', countryCode: 'IN', role: 'home', weight: 0.5 }),
            ],
            'US',
        );
        expect(primary).toMatchObject({ id: 'country:IND', kind: 'country', countryCodeAlpha2: 'IN' });
    });

    it('falls back to the highest-weight row overall when no row is role:"home"', () => {
        const primary = electPrimaryCountry(
            [
                loc({ countryCode: 'FR', role: 'travel', weight: 0.9 }),
                loc({ countryCode: 'JP', role: 'interest', weight: 0.4 }),
            ],
            'US',
        );
        expect(primary?.id).toBe('country:FRA');
    });

    it('skips a role:"home" row with an unmappable country and falls through to the next mappable row', () => {
        const primary = electPrimaryCountry(
            [
                loc({ countryCode: 'ZZ', role: 'home', weight: 0.9 }),
                loc({ countryCode: 'JP', role: 'interest', weight: 0.4 }),
            ],
            'US',
        );
        expect(primary?.id).toBe('country:JPN');
    });

    it('falls back to the device country when there are no mappable locations', () => {
        expect(electPrimaryCountry([], 'gb')?.id).toBe('country:GBR');
        expect(electPrimaryCountry([loc({ countryCode: 'ZZ', role: 'home' })], 'gb')?.id).toBe('country:GBR');
    });

    it('returns null when nothing resolves (unreachable in-app — getDeviceCountryAlpha2 never returns null)', () => {
        expect(electPrimaryCountry([], null)).toBeNull();
        expect(electPrimaryCountry([loc({ countryCode: 'ZZ' })], 'ZZ')).toBeNull();
    });
});

describe('deriveExploreScopes', () => {
    it('is World only with no locations and no device country', () => {
        const scopes = deriveExploreScopes([], null);
        expect(scopes.map((s) => s.id)).toEqual(['world']);
        expect(scopes[0]).toMatchObject({ kind: 'world', countryCodeAlpha3: null });
    });

    it('puts World first, then the device country when there are no locations', () => {
        const scopes = deriveExploreScopes([], 'US');
        expect(scopes.map((s) => s.id)).toEqual(['world', 'country:USA']);
        expect(scopes[1]).toMatchObject({ kind: 'country', countryCodeAlpha3: 'USA', countryCodeAlpha2: 'US' });
    });

    it('puts the role:"home" country first among countries, ahead of a heavier non-home one', () => {
        const scopes = deriveExploreScopes(
            [
                loc({ city: 'paris', countryCode: 'FR', role: 'interest', weight: 0.95 }),
                loc({ city: 'mumbai', countryCode: 'IN', role: 'home', weight: 0.6 }),
            ],
            'US',
        );
        expect(scopes.map((s) => s.id)).toEqual(['world', 'country:IND', 'country:FRA']);
    });

    it('puts the highest-weight location country first among countries when none is role:"home"', () => {
        const scopes = deriveExploreScopes(
            [
                loc({ city: 'paris', countryCode: 'FR', weight: 0.95 }),
                loc({ city: 'tokyo', countryCode: 'JP', weight: 0.4 }),
            ],
            'ZZ', // unmappable
        );
        expect(scopes.map((s) => s.id)).toEqual(['world', 'country:FRA', 'country:JPN']);
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

    it('dedupes the primary country out of the tail (several locations share it)', () => {
        const scopes = deriveExploreScopes(
            [
                loc({ city: 'mumbai', countryCode: 'IN', weight: 0.9 }),
                loc({ city: 'pune', countryCode: 'IN', weight: 0.8 }),
            ],
            'IN',
        );
        // A single shared country scope + world — no duplicate from the 2nd
        // location, and the primary never appears twice.
        expect(scopes.map((s) => s.id)).toEqual(['world', 'country:IND']);
    });

    it('preserves weight-desc order for the tail after the primary', () => {
        const scopes = deriveExploreScopes(
            [
                loc({ city: 'paris', countryCode: 'FR', weight: 0.95 }),
                loc({ city: 'tokyo', countryCode: 'JP', weight: 0.4 }),
                loc({ city: 'berlin', countryCode: 'DE', weight: 0.2 }),
            ],
            'US', // no role:'home' row, so FR (heaviest) wins the primary slot
        );
        expect(scopes.map((s) => s.id)).toEqual([
            'world',
            'country:FRA',
            'country:JPN',
            'country:DEU',

        ]);
    });

    it('fits exactly MAX_SCOPES - 1 countries plus World without dropping anything', () => {
        const scopes = deriveExploreScopes(
            [
                loc({ city: 'a', countryCode: 'GB', role: 'home', weight: 0.9 }),
                loc({ city: 'b', countryCode: 'FR', weight: 0.8 }),
                loc({ city: 'c', countryCode: 'DE', weight: 0.7 }),
                loc({ city: 'd', countryCode: 'IT', weight: 0.6 }),
                loc({ city: 'e', countryCode: 'ES', weight: 0.5 }),
            ],
            'US', // device country is irrelevant once a location resolves
        );
        expect(scopes).toHaveLength(MAX_SCOPES);
        expect(scopes.map((s) => s.id)).toEqual([
            'world',
            'country:GBR',
            'country:FRA',
            'country:DEU',
            'country:ITA',
            'country:ESP',
        ]);
    });

    it('keeps World first even when the country count exceeds MAX_SCOPES', () => {
        const scopes = deriveExploreScopes(
            [
                loc({ countryCode: 'GB', role: 'home', weight: 0.9 }),
                loc({ countryCode: 'FR', weight: 0.8 }),
                loc({ countryCode: 'DE', weight: 0.7 }),
                loc({ countryCode: 'IT', weight: 0.6 }),
                loc({ countryCode: 'ES', weight: 0.5 }),
                loc({ countryCode: 'NL', weight: 0.4 }),
                loc({ countryCode: 'PT', weight: 0.3 }),
                loc({ countryCode: 'SE', weight: 0.2 }),
            ],
            'US',
        );
        expect(scopes).toHaveLength(MAX_SCOPES);
        // World survives the cap because the slice applies to countries only.
        expect(scopes[0]).toMatchObject({ id: 'world', kind: 'world' });
        expect(scopes.map((s) => s.id)).toEqual([
            'world',
            'country:GBR',
            'country:FRA',
            'country:DEU',
            'country:ITA',
            'country:ESP',
        ]);
        expect(scopes.some((s) => s.id === 'country:NLD')).toBe(false);
    });

    it('skips locations with an unmappable country code', () => {
        const scopes = deriveExploreScopes([loc({ city: 'nowhere', countryCode: 'ZZ' })], null);
        expect(scopes.map((s) => s.id)).toEqual(['world']);
    });
});

describe('deriveExploreScopes — browse countries (3rd argument)', () => {
    it('appends browse countries after World-only (no locations)', () => {
        const scopes = deriveExploreScopes([], null, ['FR', 'jp']);
        expect(scopes.map((s) => s.id)).toEqual(['world', 'country:FRA', 'country:JPN']);
    });

    it('appends browse countries AFTER location-derived countries', () => {
        const scopes = deriveExploreScopes(
            [loc({ city: 'mumbai', countryCode: 'IN', role: 'home', weight: 0.9 })],
            'US',
            ['FR'],
        );
        expect(scopes.map((s) => s.id)).toEqual(['world', 'country:IND', 'country:FRA']);
    });

    it('dedupes a browse country already covered by a location (location wins the single slot)', () => {
        const scopes = deriveExploreScopes(
            [loc({ city: 'mumbai', countryCode: 'IN', role: 'home', weight: 0.9 })],
            'US',
            ['IN', 'FR'],
        );
        expect(scopes.map((s) => s.id)).toEqual(['world', 'country:IND', 'country:FRA']);
    });

    it('never lets a browse country become the primary chip — electPrimaryCountry ignores browseCountries entirely', () => {
        // No locations, device country US — primary is USA regardless of a
        // heavier-seeming browse country appended after it.
        const scopes = deriveExploreScopes([], 'US', ['FR']);
        expect(scopes[1]).toMatchObject({ id: 'country:USA' });
        expect(electPrimaryCountry([], 'US')).toMatchObject({ id: 'country:USA' });
    });

    it('is subject to the same MAX_SCOPES cap as location-derived countries', () => {
        const scopes = deriveExploreScopes(
            [
                loc({ countryCode: 'GB', role: 'home', weight: 0.9 }),
                loc({ countryCode: 'FR', weight: 0.8 }),
                loc({ countryCode: 'DE', weight: 0.7 }),
                loc({ countryCode: 'IT', weight: 0.6 }),
                loc({ countryCode: 'ES', weight: 0.5 }),
            ],
            'US',
            ['NL'],
        );
        expect(scopes).toHaveLength(MAX_SCOPES);
        expect(scopes.some((s) => s.id === 'country:NLD')).toBe(false);
    });

    it('defaults to [] when omitted (back-compat with the 2-arg call sites)', () => {
        expect(deriveExploreScopes([], 'US')).toEqual(deriveExploreScopes([], 'US', []));
    });

    it('skips an unmappable browse country code', () => {
        const scopes = deriveExploreScopes([], null, ['ZZ', 'FR']);
        expect(scopes.map((s) => s.id)).toEqual(['world', 'country:FRA']);
    });
});
