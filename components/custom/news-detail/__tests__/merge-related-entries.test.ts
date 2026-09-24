import { mergeRelatedEntries } from '../merge-related-entries';

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
