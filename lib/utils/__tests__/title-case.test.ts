import { toTitleCase } from '../title-case';

describe('toTitleCase', () => {
    it('returns an empty string for empty input', () => {
        expect(toTitleCase(null)).toBe('');
        expect(toTitleCase(undefined)).toBe('');
        expect(toTitleCase('   ')).toBe('');
    });

    // Every name below was taken from the live `publication-source` collection.
    it('leaves initialisms alone', () => {
        for (const name of ['NDTV', 'ABC', 'TSA', 'DH', 'HLN', 'RFI', 'NHK', 'NRC', 'NRK', 'RTL', 'RTCG', 'RTVNK']) {
            expect(toTitleCase(name)).toBe(name);
        }
    });

    it('leaves brand tokens containing digits alone', () => {
        expect(toTitleCase('G1')).toBe('G1');
        expect(toTitleCase('3FM')).toBe('3FM');
        expect(toTitleCase('E24')).toBe('E24');
    });

    it('un-shouts real words set in all caps', () => {
        expect(toTitleCase('STERN')).toBe('Stern');
        expect(toTitleCase('ZEIT')).toBe('Zeit');
        expect(toTitleCase('DELFI')).toBe('Delfi');
        expect(toTitleCase('IWACU')).toBe('Iwacu');
        expect(toTitleCase('RP ONLINE')).toBe('RP Online');
        expect(toTitleCase('UNBOX PH')).toBe('Unbox PH');
    });

    it('capitalizes lowercase and domain-style names', () => {
        expect(toTitleCase('globoesporte.com')).toBe('Globoesporte.com');
        expect(toTitleCase('france24.com')).toBe('France24.com');
        expect(toTitleCase('yle')).toBe('Yle');
        expect(toTitleCase('in.gr')).toBe('In.gr');
        expect(toTitleCase('barbados Today')).toBe('Barbados Today');
    });

    it('strips the feed-plumbing www. prefix', () => {
        expect(toTitleCase('www.wirtualnemedia.pl')).toBe('Wirtualnemedia.pl');
    });

    it('preserves deliberate internal capitals', () => {
        expect(toTitleCase('dzFoot.com')).toBe('dzFoot.com');
        expect(toTitleCase('myMetro')).toBe('myMetro');
        expect(toTitleCase('McClatchy')).toBe('McClatchy');
    });

    it('preserves original spacing between words', () => {
        expect(toTitleCase('philstar.com - RSS Headlines')).toBe('Philstar.com - RSS Headlines');
    });

    it('leaves caseless scripts untouched', () => {
        expect(toTitleCase('الجزيرة')).toBe('الجزيرة');
        expect(toTitleCase('人民日报')).toBe('人民日报');
        expect(toTitleCase('टाइम्स नाउ')).toBe('टाइम्स नाउ');
    });
});
