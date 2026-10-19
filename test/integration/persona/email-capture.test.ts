// Anonymous-account email helpers: anon-domain detection and the Settings identity-footer derivation.
import { emailLooksAnonymous, resolveAccountEmailView, userNeedsEmail } from '@/lib/subscription/email-capture';

describe('emailLooksAnonymous / userNeedsEmail', () => {
    it('treats the fabricated anon domain and absence as anonymous', () => {
        expect(emailLooksAnonymous(null)).toBe(true);
        expect(emailLooksAnonymous(undefined)).toBe(true);
        expect(emailLooksAnonymous('')).toBe(true);
        expect(emailLooksAnonymous('abc123@anon.mera.news')).toBe(true);
        expect(emailLooksAnonymous('ABC@ANON.MERA.NEWS')).toBe(true);
        expect(emailLooksAnonymous('real@example.com')).toBe(false);
    });

    it('userNeedsEmail: no session user means nothing to attach to', () => {
        expect(userNeedsEmail(null)).toBe(false);
        expect(userNeedsEmail(undefined)).toBe(false);
    });

    it('userNeedsEmail: isAnonymous or an anon-domain email needs one; a real email does not', () => {
        expect(userNeedsEmail({ isAnonymous: true, email: 'x@anon.mera.news' })).toBe(true);
        expect(userNeedsEmail({ isAnonymous: true, email: 'real@example.com' })).toBe(true);
        expect(userNeedsEmail({ email: 'x@anon.mera.news' })).toBe(true);
        expect(userNeedsEmail({ email: null })).toBe(true);
        expect(userNeedsEmail({ email: 'real@example.com' })).toBe(false);
    });
});

describe('resolveAccountEmailView', () => {
    it('F1 regression: a real STORED email wins over a stale anonymous session', () => {
        // In-session attach: the store updated the instant confirm succeeded, but the session atom still holds
        // the fabricated address.
        expect(
            resolveAccountEmailView({
                storedEmail: 'real@example.com',
                sessionUser: { email: 'x@anon.mera.news', isAnonymous: true },
            }),
        ).toEqual({ isAnonAccount: false, displayEmail: 'real@example.com' });
    });

    it('pre-attach anonymous account: the session decides, and no address is displayed', () => {
        expect(
            resolveAccountEmailView({ storedEmail: null, sessionUser: { email: 'x@anon.mera.news', isAnonymous: true } }),
        ).toEqual({ isAnonAccount: true, displayEmail: null });
    });

    it('an anonymous stored email never counts as a real one', () => {
        expect(
            resolveAccountEmailView({ storedEmail: 'x@anon.mera.news', sessionUser: { email: 'x@anon.mera.news' } }),
        ).toEqual({ isAnonAccount: true, displayEmail: null });
    });

    it('email-signed-in user: not anonymous, via the store or the session fallback', () => {
        expect(resolveAccountEmailView({ storedEmail: 'a@b.com', sessionUser: null })).toEqual({
            isAnonAccount: false,
            displayEmail: 'a@b.com',
        });
        expect(resolveAccountEmailView({ storedEmail: null, sessionUser: { email: 'a@b.com' } })).toEqual({
            isAnonAccount: false,
            displayEmail: 'a@b.com',
        });
    });

    it('offline with only an anonymous stored email: flagged anonymous, nothing displayed', () => {
        expect(resolveAccountEmailView({ storedEmail: 'x@anon.mera.news', sessionUser: null })).toEqual({
            isAnonAccount: true,
            displayEmail: null,
        });
    });

    it('offline with nothing local: never claims anonymous (a missing email is not proof)', () => {
        expect(resolveAccountEmailView({ storedEmail: null, sessionUser: null })).toEqual({
            isAnonAccount: false,
            displayEmail: null,
        });
    });
});
