// Anonymous-account email helper: anon-domain detection.
import { emailLooksAnonymous } from '@/lib/subscription/email-capture';

describe('emailLooksAnonymous', () => {
    it('treats the fabricated anon domain and absence as anonymous', () => {
        expect(emailLooksAnonymous(null)).toBe(true);
        expect(emailLooksAnonymous(undefined)).toBe(true);
        expect(emailLooksAnonymous('')).toBe(true);
        expect(emailLooksAnonymous('abc123@anon.mera.news')).toBe(true);
        expect(emailLooksAnonymous('ABC@ANON.MERA.NEWS')).toBe(true);
        expect(emailLooksAnonymous('real@example.com')).toBe(false);
    });
});
