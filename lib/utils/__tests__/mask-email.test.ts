import { maskEmail } from '../mask-email';

describe('maskEmail', () => {
    it('shows the first half of the local part', () => {
        expect(maskEmail('anna@example.com')).toBe('an••@example.com');
        expect(maskEmail('reader@example.com')).toBe('rea•••@example.com');
        expect(maskEmail('a@b.co')).toBe('a@b.co');
    });

    it('leaves an address with no local part alone', () => {
        expect(maskEmail('@example.com')).toBe('@example.com');
        expect(maskEmail('no-at-sign')).toBe('no-at-sign');
    });
});
