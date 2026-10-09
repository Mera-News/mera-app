// Seam test for the browse-country set: one settings row, `explore_browse_countries`, on the
// in-memory DB. The merge is pure; the reads and writes go through the real setting service.
import { getSetting, setSetting } from '@/lib/database/services/setting-service';
import {
    addBrowseCountry,
    getBrowseCountries,
    mergeBrowseCountries,
    removeBrowseCountry,
} from '@/lib/explore/browse-countries';

const KEY = 'explore_browse_countries';
const stored = async () => JSON.parse((await getSetting(KEY)) ?? 'null');

describe('mergeBrowseCountries', () => {
    it('appends a new code', () => {
        expect(mergeBrowseCountries(['US'], 'FR')).toEqual(['US', 'FR']);
    });

    it('is idempotent: merging a present code returns the same list', () => {
        expect(mergeBrowseCountries(['US', 'FR'], 'FR')).toEqual(['US', 'FR']);
    });

    it('case-normalizes both the existing list and the incoming code', () => {
        expect(mergeBrowseCountries(['us'], 'FR')).toEqual(['US', 'FR']);
        expect(mergeBrowseCountries(['US'], 'fr')).toEqual(['US', 'FR']);
        expect(mergeBrowseCountries(['us'], 'US')).toEqual(['US']);
    });

    it('trims whitespace', () => {
        expect(mergeBrowseCountries([' US '], ' fr ')).toEqual(['US', 'FR']);
    });

    it('dedupes the existing list itself, first occurrence wins', () => {
        expect(mergeBrowseCountries(['US', 'us', 'FR'], 'DE')).toEqual(['US', 'FR', 'DE']);
    });

    it('drops blank entries from the existing list', () => {
        expect(mergeBrowseCountries(['US', '', '  '], 'FR')).toEqual(['US', 'FR']);
    });

    it('returns the deduped existing list when the incoming code is blank, null or undefined', () => {
        expect(mergeBrowseCountries(['US', 'us'], '  ')).toEqual(['US']);
        expect(mergeBrowseCountries(['US'], null as unknown as string)).toEqual(['US']);
        expect(mergeBrowseCountries(['US'], undefined as unknown as string)).toEqual(['US']);
    });
});

describe('getBrowseCountries', () => {
    it('is empty when nothing is stored', async () => {
        expect(await getBrowseCountries()).toEqual([]);
    });

    it('is empty for garbage JSON rather than throwing', async () => {
        await setSetting(KEY, 'not json{{{');
        expect(await getBrowseCountries()).toEqual([]);
    });

    it('is empty when the row is valid JSON but not an array', async () => {
        await setSetting(KEY, JSON.stringify({ US: true }));
        expect(await getBrowseCountries()).toEqual([]);
    });

    it('filters out non-string members', async () => {
        await setSetting(KEY, JSON.stringify(['US', 42, null, 'FR']));
        expect(await getBrowseCountries()).toEqual(['US', 'FR']);
    });

    it('dedupes and case-normalizes stored entries', async () => {
        await setSetting(KEY, JSON.stringify(['us', 'US', ' fr ']));
        expect(await getBrowseCountries()).toEqual(['US', 'FR']);
    });
});

describe('addBrowseCountry', () => {
    it('adds to an empty set and persists the normalized code', async () => {
        expect(await addBrowseCountry('fr')).toEqual(['FR']);
        expect(await getBrowseCountries()).toEqual(['FR']);
        expect(await stored()).toEqual(['FR']);
    });

    it('is idempotent', async () => {
        await addBrowseCountry('FR');
        expect(await addBrowseCountry('fr')).toEqual(['FR']);
        expect(await stored()).toEqual(['FR']);
    });

    it('appends to an existing set', async () => {
        await addBrowseCountry('US');
        expect(await addBrowseCountry('DE')).toEqual(['US', 'DE']);
    });
});

describe('removeBrowseCountry', () => {
    it('is a no-op on an empty set', async () => {
        expect(await removeBrowseCountry('US')).toEqual([]);
    });

    it('removes a present country, matching case-insensitively', async () => {
        await addBrowseCountry('US');
        await addBrowseCountry('FR');
        expect(await removeBrowseCountry('us')).toEqual(['FR']);
        expect(await stored()).toEqual(['FR']);
    });

    it('is idempotent: removing an absent country changes nothing', async () => {
        await addBrowseCountry('FR');
        expect(await removeBrowseCountry('DE')).toEqual(['FR']);
        expect(await removeBrowseCountry('DE')).toEqual(['FR']);
    });
});
