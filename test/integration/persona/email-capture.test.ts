// Email-at-purchase: anonymous-account detection, the two server calls through the real auth client,
// the local cache refresh on confirm, the capture-request registry and the email-before-checkout gate.
// Real auth client, stores and in-memory DB over MSW. Nothing is mocked.
import database from '@/lib/database';
import { getSetting } from '@/lib/database/services/setting-service';
import { useUserStore } from '@/lib/stores/user-store';
import {
    __resetEmailCaptureForTests,
    accountNeedsEmail,
    completeEmailCapture,
    confirmEmailOtp,
    EMAIL_CAPTURE_SKIPPED_SETTING_KEY,
    emailLooksAnonymous,
    ensureEmailBeforeCheckout,
    maybeRequestEmailCaptureAfterPurchase,
    requestEmailCapture,
    requestEmailOtp,
    resolveAccountEmailView,
    subscribeEmailCapture,
    userNeedsEmail,
} from '@/lib/subscription/email-capture';
import { FIXTURE_ACCOUNT, http, HttpResponse, server } from '@/test/helpers';

/** The session the auth client reads. `null` is "no session". */
function sessionUser(user: Record<string, unknown> | null) {
    server.use(
        http.get('*/api/auth/get-session', () =>
            HttpResponse.json(
                user
                    ? {
                          session: { id: 's1', userId: 'u1', token: 't', expiresAt: '2030-01-01T00:00:00.000Z', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' },
                          user: { id: 'u1', emailVerified: true, name: 'x', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', ...user },
                      }
                    : null,
            ),
        ),
    );
}
const anonSession = () => sessionUser({ email: 'x@anon.mera.news', isAnonymous: true });
const realSession = () => sessionUser({ email: 'real@example.com' });

/** Polls on real macrotasks; the gate's session read is a real MSW round trip. */
async function until(cond: () => boolean | Promise<boolean>, ms = 3000): Promise<void> {
    for (let t = 0; t < ms && !(await cond()); t += 10) await new Promise((r) => setTimeout(r, 10));
    if (!(await cond())) throw new Error('until: condition not met');
}

beforeEach(() => {
    __resetEmailCaptureForTests();
    useUserStore.setState({ userEmail: null });
});

afterEach(async () => {
    // The skip flag is written without awaiting; a DB reset racing a write in flight hangs.
    await new Promise((r) => setTimeout(r, 25));
    await database.write(async () => {});
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

describe('accountNeedsEmail', () => {
    it('reads the session and resolves true for an anonymous account', async () => {
        anonSession();
        await expect(accountNeedsEmail()).resolves.toBe(true);
    });

    it('resolves true for the fabricated address even without the isAnonymous flag', async () => {
        sessionUser({ email: 'x@anon.mera.news' });
        await expect(accountNeedsEmail()).resolves.toBe(true);
    });

    it('resolves false for a real-email account', async () => {
        realSession();
        await expect(accountNeedsEmail()).resolves.toBe(false);
    });

    it('resolves false when there is no session, and when the session read fails: when unsure, never nag', async () => {
        sessionUser(null);
        await expect(accountNeedsEmail()).resolves.toBe(false);

        server.use(http.get('*/api/auth/get-session', () => HttpResponse.error()));
        await expect(accountNeedsEmail()).resolves.toBe(false);
    });
});

describe('requestEmailOtp', () => {
    it('posts to /device/email/request with the address and resolves ok', async () => {
        let body: unknown;
        server.use(
            http.post('*/api/auth/device/email/request', async ({ request }) => {
                body = await request.json();
                return HttpResponse.json({ ok: true });
            }),
        );
        await expect(requestEmailOtp('a@b.com')).resolves.toEqual({ ok: true });
        expect(body).toEqual({ email: 'a@b.com' });
    });

    it('maps a 4xx to invalid-email', async () => {
        server.use(http.post('*/api/auth/device/email/request', () => HttpResponse.json({ code: 'INVALID_EMAIL' }, { status: 400 })));
        await expect(requestEmailOtp('a@b.com')).resolves.toEqual({ ok: false, errorCode: 'invalid-email' });
    });

    it('maps a 5xx to server', async () => {
        server.use(http.post('*/api/auth/device/email/request', () => HttpResponse.json({ code: 'DOWN' }, { status: 503 })));
        await expect(requestEmailOtp('a@b.com')).resolves.toEqual({ ok: false, errorCode: 'server' });
    });

    it('maps a transport failure to server', async () => {
        server.use(http.post('*/api/auth/device/email/request', () => HttpResponse.error()));
        await expect(requestEmailOtp('a@b.com')).resolves.toEqual({ ok: false, errorCode: 'server' });
    });
});

describe('confirmEmailOtp', () => {
    it('on success caches the email, updates the store IN-SESSION and refreshes the session', async () => {
        let body: unknown;
        let sessionReads = 0;
        server.use(
            http.post('*/api/auth/device/email/confirm', async ({ request }) => {
                body = await request.json();
                return HttpResponse.json({ ok: true });
            }),
            http.get('*/api/auth/get-session', () => {
                sessionReads += 1;
                return HttpResponse.json(null);
            }),
        );

        await expect(confirmEmailOtp('a@b.com', FIXTURE_ACCOUNT.otp)).resolves.toEqual({ ok: true });

        expect(body).toEqual({ email: 'a@b.com', otp: FIXTURE_ACCOUNT.otp });
        await expect(getSetting('cached_user_email')).resolves.toBe('a@b.com');
        // A synchronous store write: this is what makes Settings drop the "Add an email" row and show the
        // masked address WITHOUT an app restart (F1).
        expect(useUserStore.getState().userEmail).toBe('a@b.com');
        await until(() => sessionReads > 0);
    });

    it('maps a 4xx to invalid-otp and writes NOTHING locally', async () => {
        await expect(confirmEmailOtp('a@b.com', '000000')).resolves.toEqual({ ok: false, errorCode: 'invalid-otp' });
        await expect(getSetting('cached_user_email')).resolves.toBeNull();
        expect(useUserStore.getState().userEmail).toBeNull();
    });

    it('maps a 5xx to server and writes nothing locally', async () => {
        server.use(http.post('*/api/auth/device/email/confirm', () => HttpResponse.json({}, { status: 500 })));
        await expect(confirmEmailOtp('a@b.com', FIXTURE_ACCOUNT.otp)).resolves.toEqual({ ok: false, errorCode: 'server' });
        await expect(getSetting('cached_user_email')).resolves.toBeNull();
    });

    it('a transport failure resolves as a server error, never a crash', async () => {
        server.use(http.post('*/api/auth/device/email/confirm', () => HttpResponse.error()));
        await expect(confirmEmailOtp('a@b.com', FIXTURE_ACCOUNT.otp)).resolves.toEqual({ ok: false, errorCode: 'server' });
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
    it('a verified-email account goes straight through, no sheet', async () => {
        realSession();
        const seen: string[] = [];
        subscribeEmailCapture((source) => seen.push(source));

        await expect(ensureEmailBeforeCheckout()).resolves.toBe(true);
        expect(seen).toEqual([]);
    });

    it('an anonymous account raises the checkout sheet and proceeds ONLY on verified', async () => {
        anonSession();
        const seen: string[] = [];
        subscribeEmailCapture((source) => seen.push(source));

        const gate = ensureEmailBeforeCheckout();
        let settled = false;
        void gate.then(() => (settled = true));
        await until(() => seen.length > 0);
        expect(seen).toEqual(['checkout']);
        expect(settled).toBe(false);

        completeEmailCapture('verified');
        await expect(gate).resolves.toBe(true);
    });

    it('a dismissed sheet aborts checkout (resolves false)', async () => {
        anonSession();
        const seen: string[] = [];
        subscribeEmailCapture((source) => seen.push(source));

        const gate = ensureEmailBeforeCheckout();
        await until(() => seen.length > 0);
        completeEmailCapture('dismissed');
        await expect(gate).resolves.toBe(false);
    });

    it('fails OPEN: an unreadable session never bricks a purchase', async () => {
        server.use(http.get('*/api/auth/get-session', () => HttpResponse.error()));
        subscribeEmailCapture(() => {});
        await expect(ensureEmailBeforeCheckout()).resolves.toBe(true);
    });

    it('fails OPEN: no mounted host to present the sheet never bricks a purchase', async () => {
        anonSession();
        // No listener subscribed.
        await expect(ensureEmailBeforeCheckout()).resolves.toBe(true);
    });

    it('an INFORMED SKIP lets checkout proceed (resolves true) and persists the flag', async () => {
        anonSession();
        const seen: string[] = [];
        subscribeEmailCapture((source) => seen.push(source));

        const gate = ensureEmailBeforeCheckout();
        await until(() => seen.length > 0);
        completeEmailCapture('skipped');
        await expect(gate).resolves.toBe(true);
        await until(async () => (await getSetting(EMAIL_CAPTURE_SKIPPED_SETTING_KEY)) === '1');
    });

    it('a second gate supersedes a dangling one: the first resolves false, the second waits', async () => {
        anonSession();
        const seen: string[] = [];
        subscribeEmailCapture((source) => seen.push(source));

        const first = ensureEmailBeforeCheckout();
        await until(() => seen.length === 1);
        const second = ensureEmailBeforeCheckout();
        await expect(first).resolves.toBe(false);
        await until(() => seen.length === 2);
        completeEmailCapture('verified');
        await expect(second).resolves.toBe(true);
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

        sessionUser({ email: 'x@anon.mera.news' });
        await maybeRequestEmailCaptureAfterPurchase();
        expect(seen).toEqual(['purchase']);

        realSession();
        await maybeRequestEmailCaptureAfterPurchase();
        expect(seen).toEqual(['purchase']);
    });

    it('is silenced by an informed skip made at checkout: the fallback ask never returns, even for an anonymous account', async () => {
        anonSession();
        const seen: string[] = [];
        subscribeEmailCapture((source) => seen.push(source));

        // The user skips at checkout through the real gate, which writes the flag.
        const gate = ensureEmailBeforeCheckout();
        await until(() => seen.length === 1);
        completeEmailCapture('skipped');
        await gate;
        await until(async () => (await getSetting(EMAIL_CAPTURE_SKIPPED_SETTING_KEY)) === '1');

        await maybeRequestEmailCaptureAfterPurchase();
        expect(seen).toEqual(['checkout']);
    });
});
