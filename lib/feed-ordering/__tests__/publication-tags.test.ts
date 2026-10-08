import {
    isMutedPublication,
    publicationTagMultiplier,
    rankedRelevance,
    type RankingContext,
} from '../publication-tags';

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

describe('rankedRelevance', () => {
    const c = ctx([
        ['the paper', 1.5],
        ['subbed', 2],
        ['less', 0.5],
        ['gone', 0],
    ]);

    it('weighs by the normalised publication name', () => {
        expect(rankedRelevance(0.4, '  The   Paper ', c)).toBeCloseTo(0.6);
        expect(rankedRelevance(0.8, 'Less', c)).toBeCloseTo(0.4);
        expect(rankedRelevance(0.7, 'unknown', c)).toBe(0.7);
        expect(rankedRelevance(0.7, null, c)).toBe(0.7);
        expect(rankedRelevance(0.7, 'Subbed', null)).toBe(0.7);
    });

    it('caps at the emergency cutoff and never weighs an emergency', () => {
        expect(rankedRelevance(0.6, 'Subbed', c)).toBe(1.0);
        expect(rankedRelevance(1.1, 'Less', c)).toBe(1.1);
        expect(rankedRelevance(1.1, 'Subbed', c)).toBe(1.1);
    });

    it('marks a muted publication', () => {
        expect(isMutedPublication('GONE', c)).toBe(true);
        expect(isMutedPublication('Less', c)).toBe(false);
        expect(isMutedPublication('x', null)).toBe(false);
    });
});
