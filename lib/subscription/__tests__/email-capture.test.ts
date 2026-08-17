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
jest.mock('@/lib/database/services/setting-service', () => ({
    setSetting: (...args: unknown[]) => mockSetSetting(...args),
}));

const mockHydrateFromDb = jest.fn();
jest.mock('@/lib/stores/user-store', () => ({
    useUserStore: {
        getState: () => ({ hydrateFromDb: mockHydrateFromDb }),
    },
}));

jest.mock('@/lib/logger', () => ({
    __esModule: true,
    default: { debug: jest.fn(), captureException: jest.fn(), captureMessage: jest.fn() },
}));

import {
    __resetEmailCaptureForTests,
    accountNeedsEmail,
    confirmEmailOtp,
    emailLooksAnonymous,
    maybeRequestEmailCaptureAfterPurchase,
    requestEmailCapture,
    requestEmailOtp,
    subscribeEmailCapture,
    userNeedsEmail,
} from '../email-capture';

beforeEach(() => {
    jest.clearAllMocks();
    __resetEmailCaptureForTests();
    mockGetSession.mockResolvedValue(null);
    mockHydrateFromDb.mockResolvedValue(undefined);
    mockSetSetting.mockResolvedValue(undefined);
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
    it('on success caches the email, rehydrates the store and refreshes the session', async () => {
        mockFetch.mockResolvedValue({ data: { success: true }, error: null });

        expect(await confirmEmailOtp('a@b.com', '123456')).toEqual({ ok: true });

        expect(mockFetch).toHaveBeenCalledWith('/device/email/confirm', {
            method: 'POST',
            body: { email: 'a@b.com', otp: '123456' },
        });
        expect(mockSetSetting).toHaveBeenCalledWith('cached_user_email', 'a@b.com');
        expect(mockHydrateFromDb).toHaveBeenCalled();
        expect(mockGetSession).toHaveBeenCalled();
    });

    it('maps a 4xx to invalid-otp and writes NOTHING locally', async () => {
        mockFetch.mockResolvedValue({ data: null, error: { status: 400, code: 'INVALID_OTP' } });

        expect(await confirmEmailOtp('a@b.com', '000000')).toEqual({
            ok: false,
            errorCode: 'invalid-otp',
        });
        expect(mockSetSetting).not.toHaveBeenCalled();
        expect(mockHydrateFromDb).not.toHaveBeenCalled();
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
});
