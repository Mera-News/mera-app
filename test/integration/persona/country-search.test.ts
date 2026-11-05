// Pure: the country matches Sources search shows, by app-language name, English name and alias.
import { localizedCountryName, searchSourceCountries } from '@/components/custom/publication-preferences/country-search';

describe('searchSourceCountries', () => {
    it('finds Germany by its German name when the app is German', () => {
        const hit = searchSourceCountries('Deutschland', 'de')[0];
        expect(hit).toMatchObject({ alpha2: 'DE', alpha3: 'DEU', name: 'Deutschland', label: 'Germany' });
    });

    it.each([
        ['USA', 'USA'],
        ['UK', 'GBR'],
    ])('finds %s by its English alias', (query, alpha3) => {
        expect(searchSourceCountries(query, 'en').map((c) => c.alpha3)).toContain(alpha3);
    });

    it('still finds a country by its English name in another language', () => {
        expect(searchSourceCountries('germany', 'de').map((c) => c.alpha3)).toContain('DEU');
    });

    it('ranks start-of-name first and caps at 5', () => {
        expect(searchSourceCountries('an', 'en')).toHaveLength(5);
        // "San Marino" holds "an" too; Andorra starts with it.
        expect(searchSourceCountries('an', 'en')[0].name).toMatch(/^An/);
        expect(searchSourceCountries('fra', 'en')[0].name).toBe('France');
    });

    it('in English uses the name the rest of the app shows, not the official form', () => {
        expect(searchSourceCountries('United States', 'en')[0].name).toBe('United States');
        expect(localizedCountryName('USA', 'en')).toBe('United States');
    });

    it('offers nothing for an empty query', () => {
        expect(searchSourceCountries('  ', 'en')).toEqual([]);
    });

    it('keeps English for zh-TW, which has no list', () => {
        expect(localizedCountryName('DEU', 'zh-TW')).toBe('Germany');
        expect(localizedCountryName('DEU', 'zh-CN')).not.toBe('Germany');
    });
});
