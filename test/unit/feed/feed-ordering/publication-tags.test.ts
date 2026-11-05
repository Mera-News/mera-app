import {
    isMutedPublication,
    publicationTagMultiplier,
    rankedRelevance,
    type RankingContext,
} from '@/lib/feed-ordering/publication-tags';

const ctx = (entries: [string, number][]): RankingContext => ({
    homeCountryAlpha3: null,
    otherCountriesAlpha3: [],
    appLanguageBase: null,
    publicationMultipliers: new Map(entries),
});

describe('publicationTagMultiplier', () => {
    it('is the owner table, multiplied, with Mute absorbing', () => {
        expect(publicationTagMultiplier('more', false)).toBe(1.5);
        expect(publicationTagMultiplier('fewer', false)).toBe(0.5);
        expect(publicationTagMultiplier(null, true)).toBe(2);
        expect(publicationTagMultiplier('more', true)).toBe(3);
        expect(publicationTagMultiplier('fewer', true)).toBe(1);
        expect(publicationTagMultiplier('mute', true)).toBe(0);
        expect(publicationTagMultiplier(null, false)).toBe(1);
    });
});

const row = (publication_name: string | null, country_code: string | null = null) => ({ publication_name, country_code });

describe('rankedRelevance', () => {
    const c = ctx([
        ['the paper', 1.5],
        ['subbed', 2],
        ['less', 0.5],
        ['gone', 0],
    ]);

    it('weighs by the normalised publication name', () => {
        expect(rankedRelevance(0.4, row('  The   Paper '), c)).toBeCloseTo(0.6);
        expect(rankedRelevance(0.8, row('Less'), c)).toBeCloseTo(0.4);
        expect(rankedRelevance(0.7, row('unknown'), c)).toBe(0.7);
        expect(rankedRelevance(0.7, row(null), c)).toBe(0.7);
        expect(rankedRelevance(0.7, row('Subbed'), null)).toBe(0.7);
    });

    it('caps at the emergency cutoff and never weighs an emergency', () => {
        expect(rankedRelevance(0.6, row('Subbed'), c)).toBe(1.0);
        expect(rankedRelevance(1.1, row('Less'), c)).toBe(1.1);
        expect(rankedRelevance(1.1, row('Subbed'), c)).toBe(1.1);
    });

    it('marks a muted publication', () => {
        expect(isMutedPublication('GONE', c)).toBe(true);
        expect(isMutedPublication('Less', c)).toBe(false);
        expect(isMutedPublication('x', null)).toBe(false);
    });
});

describe('a preferred country', () => {
    const c: RankingContext = {
        homeCountryAlpha3: null,
        otherCountriesAlpha3: [],
        appLanguageBase: 'en',
        preferredCountriesAlpha3: new Set(['IND']),
        publicationMultipliers: new Map([
            ['starred', 1.5],
            ['subbed', 2],
            ['less', 0.5],
            ['cancelled', 1],
            ['gone', 0],
        ]),
    };

    it('gives an untagged publication x1.5, with no multiplier map at all too', () => {
        expect(rankedRelevance(0.4, row('The Hindu', ' ind '), c)).toBeCloseTo(0.6);
        const { publicationMultipliers: _, ...noMap } = c;
        expect(rankedRelevance(0.4, row('The Hindu', 'IND'), noMap)).toBeCloseTo(0.6);
    });

    it('leaves another country, a null country and GLOBAL alone', () => {
        expect(rankedRelevance(0.4, row('x', 'DEU'), c)).toBe(0.4);
        expect(rankedRelevance(0.4, row('x', null), c)).toBe(0.4);
        expect(rankedRelevance(0.4, row('x', 'GLOBAL'), c)).toBe(0.4);
    });

    it('never stacks: a publication with its own tags keeps them', () => {
        expect(rankedRelevance(0.4, row('Starred', 'IND'), c)).toBeCloseTo(0.6);
        expect(rankedRelevance(0.4, row('Subbed', 'IND'), c)).toBeCloseTo(0.8);
        expect(rankedRelevance(0.4, row('Less', 'IND'), c)).toBeCloseTo(0.2);
        expect(rankedRelevance(0.4, row('Cancelled', 'IND'), c)).toBe(0.4);
    });

    it('stays under the emergency cutoff and never weighs an emergency', () => {
        expect(rankedRelevance(0.95, row('x', 'IND'), c, 1)).toBe(1);
        expect(rankedRelevance(1.1, row('x', 'IND'), c, 1)).toBe(1.1);
    });

    it('does not lift a Not preferred publication out of its filter', () => {
        expect(isMutedPublication('Gone', c)).toBe(true);
        expect(isMutedPublication('The Hindu', c)).toBe(false);
    });
});
