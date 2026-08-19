/**
 * Email-at-purchase view-model logic (lib/subscription/email-capture.ts):
 * anonymous-account detection, the two server calls, the local cache refresh
 * on confirm, and the capture-request registry the purchase chokepoint and
 * the Settings row both raise.
 */

const mockFetch = jest.fn();
const mockGetSession = jest.fn();
jest.mock('@/lib/auth-client', () => ({
    authClient: {
        $fetch: (...args: unknown[]) => mockFetch(...args),
        getSession: (...args: unknown[]) => mockGetSession(...args),
    },
}));

const mockSetSetting = jest.fn();
const mockGetSetting = jest.fn();
jest.mock('@/lib/database/services/setting-service', () => ({
    setSetting: (...args: unknown[]) => mockSetSetting(...args),
    getSetting: (...args: unknown[]) => mockGetSetting(...args),
}));

const mockSetState = jest.fn();
jest.mock('@/lib/stores/user-store', () => ({
    useUserStore: {
        setState: (...args: unknown[]) => mockSetState(...args),
    },
}));

jest.mock('@/lib/logger', () => ({
    __esModule: true,
    default: { debug: jest.fn(), captureException: jest.fn(), captureMessage: jest.fn() },
}));

import {
    __resetEmailCaptureForTests,
    EMAIL_CAPTURE_SKIPPED_SETTING_KEY,
    completeEmailCapture,
    ensureEmailBeforeCheckout,
    accountNeedsEmail,
    confirmEmailOtp,
    emailLooksAnonymous,
    maybeRequestEmailCaptureAfterPurchase,
    requestEmailCapture,
    requestEmailOtp,
    resolveAccountEmailView,
    subscribeEmailCapture,
    userNeedsEmail,
} from '../email-capture';

beforeEach(() => {
    jest.clearAllMocks();
    __resetEmailCaptureForTests();
    mockGetSession.mockResolvedValue(null);
    mockSetSetting.mockResolvedValue(undefined);
    mockGetSetting.mockResolvedValue(null);
});

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
        expect(userNeedsEmail({ email: 'x@anon.mera.news' })).toBe(true);
        expect(userNeedsEmail({ email: null })).toBe(true);
        expect(userNeedsEmail({ email: 'real@example.com' })).toBe(false);
    });
});

describe('resolveAccountEmailView', () => {
    it('F1 regression: a real STORED email wins over a stale anonymous session', () => {
        // In-session attach: the store updated the instant confirm succeeded,
        // but better-auth's session atom still holds the fabricated address.
        expect(
            resolveAccountEmailView({
                storedEmail: 'real@example.com',
                sessionUser: { email: 'x@anon.mera.news', isAnonymous: true },
            }),
        ).toEqual({ isAnonAccount: false, displayEmail: 'real@example.com' });
    });

    it('pre-attach anonymous account: session decides, row shows, no address displayed', () => {
        expect(
            resolveAccountEmailView({
                storedEmail: null,
                sessionUser: { email: 'x@anon.mera.news', isAnonymous: true },
            }),
        ).toEqual({ isAnonAccount: true, displayEmail: null });
    });

    it('email-signed-in user: not anonymous, via store or session fallback', () => {
        expect(
            resolveAccountEmailView({ storedEmail: 'a@b.com', sessionUser: null }),
        ).toEqual({ isAnonAccount: false, displayEmail: 'a@b.com' });
        expect(
            resolveAccountEmailView({
                storedEmail: null,
                sessionUser: { email: 'a@b.com' },
            }),
        ).toEqual({ isAnonAccount: false, displayEmail: 'a@b.com' });
    });

    it('offline with nothing local: never claims anonymous (a missing email is not proof)', () => {
        expect(resolveAccountEmailView({ storedEmail: null, sessionUser: null })).toEqual({
            isAnonAccount: false,
            displayEmail: null,
        });
    });
});

describe('accountNeedsEmail', () => {
    it('reads the session and resolves true for an anonymous account', async () => {
        mockGetSession.mockResolvedValue({
            data: { user: { id: 'u1', email: 'x@anon.mera.news', isAnonymous: true } },
        });
        expect(await accountNeedsEmail()).toBe(true);
    });

    it('resolves false for a real-email account and false when unsure (error)', async () => {
        mockGetSession.mockResolvedValue({
            data: { user: { id: 'u1', email: 'real@example.com' } },
        });
        expect(await accountNeedsEmail()).toBe(false);

        mockGetSession.mockRejectedValue(new Error('offline'));
        expect(await accountNeedsEmail()).toBe(false);
    });
});

describe('requestEmailOtp', () => {
    it('posts to /device/email/request and resolves ok', async () => {
        mockFetch.mockResolvedValue({ data: { success: true }, error: null });
        expect(await requestEmailOtp('a@b.com')).toEqual({ ok: true });
        expect(mockFetch).toHaveBeenCalledWith('/device/email/request', {
            method: 'POST',
            body: { email: 'a@b.com' },
        });
    });

    it('maps a 4xx to invalid-email and a 5xx or throw to server', async () => {
        mockFetch.mockResolvedValue({ data: null, error: { status: 400 } });
        expect(await requestEmailOtp('a@b.com')).toEqual({ ok: false, errorCode: 'invalid-email' });

        mockFetch.mockResolvedValue({ data: null, error: { status: 503 } });
        expect(await requestEmailOtp('a@b.com')).toEqual({ ok: false, errorCode: 'server' });

        mockFetch.mockRejectedValue(new TypeError('Network request failed'));
        expect(await requestEmailOtp('a@b.com')).toEqual({ ok: false, errorCode: 'server' });
    });
});

describe('confirmEmailOtp', () => {
    it('on success caches the email, updates the store IN-SESSION and refreshes the session', async () => {
        mockFetch.mockResolvedValue({ data: { success: true }, error: null });

        expect(await confirmEmailOtp('a@b.com', '123456')).toEqual({ ok: true });

        expect(mockFetch).toHaveBeenCalledWith('/device/email/confirm', {
            method: 'POST',
            body: { email: 'a@b.com', otp: '123456' },
        });
        expect(mockSetSetting).toHaveBeenCalledWith('cached_user_email', 'a@b.com');
        // Synchronous store write, not a fire-and-forget hydrate: this is what
        // makes Settings drop the "Add email address" row and show the masked
        // email WITHOUT an app restart (F1).
        expect(mockSetState).toHaveBeenCalledWith({ userEmail: 'a@b.com' });
        expect(mockGetSession).toHaveBeenCalled();
    });

    it('maps a 4xx to invalid-otp and writes NOTHING locally', async () => {
        mockFetch.mockResolvedValue({ data: null, error: { status: 400, code: 'INVALID_OTP' } });

        expect(await confirmEmailOtp('a@b.com', '000000')).toEqual({
            ok: false,
            errorCode: 'invalid-otp',
        });
        expect(mockSetSetting).not.toHaveBeenCalled();
        expect(mockSetState).not.toHaveBeenCalled();
    });

    it('a throw resolves as a server error, never a crash', async () => {
        mockFetch.mockRejectedValue(new Error('boom'));
        expect(await confirmEmailOtp('a@b.com', '123456')).toEqual({
            ok: false,
            errorCode: 'server',
        });
    });
});

describe('capture-request registry', () => {
    it('notifies subscribers with the source and stops after unsubscribe', () => {
        const seen: string[] = [];
        const unsubscribe = subscribeEmailCapture((source) => seen.push(source));

        requestEmailCapture('purchase');
        requestEmailCapture('settings');
        unsubscribe();
        requestEmailCapture('purchase');

        expect(seen).toEqual(['purchase', 'settings']);
    });

    it('one throwing listener does not stop the others', () => {
        const seen: string[] = [];
        subscribeEmailCapture(() => {
            throw new Error('broken listener');
        });
        subscribeEmailCapture((source) => seen.push(source));

        requestEmailCapture('purchase');

        expect(seen).toEqual(['purchase']);
    });
});

describe('ensureEmailBeforeCheckout (S10)', () => {
    const anonSession = () =>
        mockGetSession.mockResolvedValue({
            data: { user: { id: 'u1', email: 'x@anon.mera.news', isAnonymous: true } },
        });

    it('a verified-email account goes straight through, no sheet', async () => {
        mockGetSession.mockResolvedValue({
            data: { user: { id: 'u1', email: 'real@example.com' } },
        });
        const seen: string[] = [];
        subscribeEmailCapture((source) => seen.push(source));

        expect(await ensureEmailBeforeCheckout()).toBe(true);
        expect(seen).toEqual([]);
    });

    it('an anonymous account raises the checkout sheet and proceeds ONLY on verified', async () => {
        anonSession();
        const seen: string[] = [];
        subscribeEmailCapture((source) => seen.push(source));

        const gate = ensureEmailBeforeCheckout();
        // Let the async needs-email check settle and arm the resolver.
        await new Promise((r) => setTimeout(r, 0));
        expect(seen).toEqual(['checkout']);

        completeEmailCapture('verified');
        expect(await gate).toBe(true);
    });

    it('a dismissed sheet aborts checkout (resolves false)', async () => {
        anonSession();
        subscribeEmailCapture(() => {});

        const gate = ensureEmailBeforeCheckout();
        await new Promise((r) => setTimeout(r, 0));
        completeEmailCapture('dismissed');
        expect(await gate).toBe(false);
    });

    it('fails OPEN: unreadable session or no mounted host never bricks a purchase', async () => {
        mockGetSession.mockRejectedValue(new Error('offline'));
        expect(await ensureEmailBeforeCheckout()).toBe(true);

        anonSession();
        // No listeners subscribed — no host to present the sheet.
        expect(await ensureEmailBeforeCheckout()).toBe(true);
    });

    it('an INFORMED SKIP lets checkout proceed (resolves true) and persists the flag', async () => {
        anonSession();
        subscribeEmailCapture(() => {});

        const gate = ensureEmailBeforeCheckout();
        await new Promise((r) => setTimeout(r, 0));
        completeEmailCapture('skipped');
        expect(await gate).toBe(true);
        expect(mockSetSetting).toHaveBeenCalledWith(EMAIL_CAPTURE_SKIPPED_SETTING_KEY, '1');
    });

    it('completeEmailCapture with no armed gate is a safe no-op (settings/purchase closes)', () => {
        expect(() => completeEmailCapture('verified')).not.toThrow();
        expect(() => completeEmailCapture('dismissed')).not.toThrow();
    });
});

describe('maybeRequestEmailCaptureAfterPurchase', () => {
    it('raises a purchase capture request only for accounts that need an email', async () => {
        const seen: string[] = [];
        subscribeEmailCapture((source) => seen.push(source));

        mockGetSession.mockResolvedValue({
            data: { user: { id: 'u1', email: 'x@anon.mera.news' } },
        });
        await maybeRequestEmailCaptureAfterPurchase();
        expect(seen).toEqual(['purchase']);

        mockGetSession.mockResolvedValue({
            data: { user: { id: 'u1', email: 'real@example.com' } },
        });
        await maybeRequestEmailCaptureAfterPurchase();
        expect(seen).toEqual(['purchase']);
    });

    it('stands down PERMANENTLY once the informed skip flag is set, even for anon accounts', async () => {
        const seen: string[] = [];
        subscribeEmailCapture((source) => seen.push(source));
        mockGetSetting.mockImplementation(async (k: string) =>
            k === EMAIL_CAPTURE_SKIPPED_SETTING_KEY ? '1' : null,
        );
        mockGetSession.mockResolvedValue({
            data: { user: { id: 'u1', email: 'x@anon.mera.news' } },
        });

        await maybeRequestEmailCaptureAfterPurchase();
        expect(seen).toEqual([]);
    });
});
