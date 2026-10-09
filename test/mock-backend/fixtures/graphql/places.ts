import type { Place } from '@/lib/generated/graphql-types';

export const places: Place[] = [
    {
        __typename: 'Place',
        _id: '66e2e0000000000000000010',
        city: 'Amsterdam',
        region: 'North Holland',
        countryCode: 'NLD',
        displayName: 'Amsterdam, North Holland, Netherlands',
        normalized: 'amsterdam',
        population: 921402,
        latitude: 52.3676,
        longitude: 4.9041,
        search_keys: ['amsterdam', 'amsterdam north holland'],
    },
];

/** ISO alpha-3 codes, as `allCountries` returns them. */
export const countries: string[] = ['DEU', 'GBR', 'IND', 'NLD', 'USA'];
