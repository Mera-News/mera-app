import { isStarredPublication } from '@/components/custom/cards/starred-publications';

describe('isStarredPublication', () => {
    const names = new Set(['the hindu']);

    it('matches the raw name case- and whitespace-insensitively', () => {
        expect(isStarredPublication(names, '  The   HINDU ')).toBe(true);
    });

    it('is false for other, empty and missing names', () => {
        expect(isStarredPublication(names, 'Hindustan Times')).toBe(false);
        expect(isStarredPublication(names, '')).toBe(false);
        expect(isStarredPublication(names, null)).toBe(false);
    });
});
