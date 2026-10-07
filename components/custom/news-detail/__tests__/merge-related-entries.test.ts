import { leadWithOrigin, mergeRelatedEntries } from '../merge-related-entries';

type E = { id: string; from: 'local' | 'server' };
const l = (id: string): E => ({ id, from: 'local' });
const s = (id: string): E => ({ id, from: 'server' });

describe('mergeRelatedEntries', () => {
    it('keeps one entry per article id, local winning over server', () => {
        const out = mergeRelatedEntries([l('a'), l('b')], [s('b'), s('c')], 'self');
        expect(out).toEqual([l('a'), l('b'), s('c')]);
    });

    it('drops duplicates inside one block too', () => {
        const out = mergeRelatedEntries([l('a'), l('a')], [s('c'), s('c')], null);
        expect(out.map((e) => e.id)).toEqual(['a', 'c']);
    });

    it('never lists the article on screen as related to itself', () => {
        const out = mergeRelatedEntries([l('self')], [s('self'), s('x')], 'self');
        expect(out.map((e) => e.id)).toEqual(['x']);
    });

    it('produces ids that are unique React keys', () => {
        const out = mergeRelatedEntries([l('6ab2'), l('b')], [s('6ab2'), s('6ab2'), s('c')], null);
        expect(new Set(out.map((e) => e.id)).size).toBe(out.length);
    });
});

describe('leadWithOrigin', () => {
    it('moves the article you came from to the top, the rest in order', () => {
        expect(leadWithOrigin([s('a'), s('b'), s('o'), s('c')], 'o').map((e) => e.id)).toEqual(['o', 'a', 'b', 'c']);
    });

    it('leaves the list alone when the origin is absent, already first, or unknown', () => {
        const list = [s('a'), s('b')];
        expect(leadWithOrigin(list, 'x')).toBe(list);
        expect(leadWithOrigin(list, 'a')).toBe(list);
        expect(leadWithOrigin(list, null)).toBe(list);
    });
});
