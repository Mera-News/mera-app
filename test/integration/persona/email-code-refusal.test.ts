// Seam test for signInWithEmailCode, the sign-in gate's code step (invariant 19): a code for a
// DIFFERENT account is refused and never wipes. Real auth client, secure store, identity gate
// and MSW; the server's answers are the only thing overridden.
import Constants from 'expo-constants';
import { signInWithEmailCode, type EmailCodeSignIn } from '@/components/custom/auth/email-code-sign-in';
import {
    __resetIdentityStateForTests,
    isAccountSwitchHeld,
    holdAccountSwitch,
    readPendingAuthUserId,
} from '@/lib/security/identity-gate';
import {
    __resetAuthReadQuarantineForTests,
    releaseAuthReadQuarantine,
} from '@/lib/security/install-boundary-latch';
import {
    FIXTURE_ACCOUNT,
    HttpResponse,
    advanceUntilDone,
    failSecureStore,
    http,
    secureStoreDump,
    server,
    useFakeClock,
} from '@/test/helpers';
import { authHandlers } from '@/test/mock-backend/auth';

const SLUG = Constants.expoConfig?.slug || 'app';
const COOKIE_KEY = `${SLUG}_cookie`;
const SESSION_KEY = `${SLUG}_session_data`;
const SIGN_IN = '*/api/auth/sign-in/email-otp';
const SIGN_OUT = '*/api/auth/sign-out';

const ME = FIXTURE_ACCOUNT.userId;
const OTHER = 'bbbbbbbbbbbbbbbbbbbbbbbb';
const EMAIL = FIXTURE_ACCOUNT.email;
const CODE = FIXTURE_ACCOUNT.otp;

/** Runs the mock backend's own handler, then reports the session as belonging to `userId`. The
 *  cookie and the server-side session stay real, so a sign-out has something to end. */
const signInAs = (userId: string) => async ({ request }: { request: Request }) => {
    const original = authHandlers.find((h) => (h as any).info.path === SIGN_IN) as any;
    const { response } = await original.run({ request: request.clone(), requestId: 'persona-u5' });
    const body = await response.clone().json();
    return new Response(JSON.stringify({ ...body, user: { ...body.user, id: userId } }), {
        headers: response.headers,
    });
};

/** Records the body of every request to `url` and lets the next handler answer. */
function record(method: 'post', url: string) {
    const bodies: Record<string, unknown>[] = [];
    server.use(
        http[method](url, async ({ request }) => {
            bodies.push((await request.clone().json().catch(() => ({}))) as Record<string, unknown>);
        }),
    );
    return bodies;
}

const sessionKeys = () => Object.keys(secureStoreDump()).filter((k) => k === COOKIE_KEY || k === SESSION_KEY);

beforeEach(() => {
    jest.clearAllMocks();
    __resetIdentityStateForTests();
    __resetAuthReadQuarantineForTests();
    // The boundary has decided in a normal launch; until then every sync cookie read is null.
    releaseAuthReadQuarantine();
});

describe('signInWithEmailCode', () => {
    it('a first sign-in sends no expectedUserId and accepts the account', async () => {
        const sent = record('post', SIGN_IN);

        const result = await signInWithEmailCode(EMAIL, CODE, null);

        expect(result).toEqual({ kind: 'ok', userId: ME });
        expect(sent).toEqual([{ email: EMAIL, otp: CODE }]);
        expect(sessionKeys()).toContain(COOKIE_KEY);
    });

    it('the gate sends the expected id and accepts the same account', async () => {
        const sent = record('post', SIGN_IN);

        const result = await signInWithEmailCode(EMAIL, CODE, ME);

        expect(result).toEqual({ kind: 'ok', userId: ME });
        expect(sent).toEqual([{ email: EMAIL, otp: CODE, expectedUserId: ME }]);
        expect(sessionKeys()).toContain(COOKIE_KEY);
    });

    it('a good sign-in releases a hold left by an earlier refusal', async () => {
        holdAccountSwitch(OTHER);

        await signInWithEmailCode(EMAIL, CODE, ME);

        expect(isAccountSwitchHeld(OTHER)).toBe(false);
    });

    it('a wrong code is "wrong" and is not retried', async () => {
        const sent = record('post', SIGN_IN);

        const result = await signInWithEmailCode(EMAIL, '000000', ME);

        expect(result).toEqual({ kind: 'wrong' });
        expect(sent).toHaveLength(1);
        expect(sessionKeys()).toEqual([]);
    });

    it('the server refusal (409 REAUTH_ACCOUNT_MISMATCH) is a mismatch: no session, no cookie, nothing recorded', async () => {
        const result = await signInWithEmailCode(EMAIL, CODE, OTHER);

        expect(result).toEqual({ kind: 'mismatch' });
        expect(sessionKeys()).toEqual([]);
        expect(readPendingAuthUserId()).toBeNull();
        // The server created nothing, so there is nothing to hold.
        expect(isAccountSwitchHeld(ME)).toBe(false);
    });

    describe('a server that signs in ANOTHER account', () => {
        beforeEach(() => server.use(http.post(SIGN_IN, signInAs(OTHER))));

        it('is refused: held, signed out, cookie and session keys deleted, nothing recorded', async () => {
            let signOutSent = 0;
            server.use(
                http.post(SIGN_OUT, () => {
                    signOutSent += 1;
                }),
            );

            const result = await signInWithEmailCode(EMAIL, CODE, ME);

            expect(result).toEqual({ kind: 'mismatch' });
            expect(isAccountSwitchHeld(OTHER)).toBe(true);
            expect(signOutSent).toBe(1);
            expect(sessionKeys()).toEqual([]);
            expect(readPendingAuthUserId()).toBeNull();
        });

        it('keeps the hold after the refusal: only the next good sign-in releases it', async () => {
            await signInWithEmailCode(EMAIL, CODE, ME);
            expect(isAccountSwitchHeld(OTHER)).toBe(true);

            server.resetHandlers();
            await signInWithEmailCode(EMAIL, CODE, ME);
            expect(isAccountSwitchHeld(OTHER)).toBe(false);
        });

        it('a failed sign-out still deletes the cookie', async () => {
            server.use(http.post(SIGN_OUT, () => HttpResponse.error()));

            const result = await signInWithEmailCode(EMAIL, CODE, ME);

            expect(result).toEqual({ kind: 'mismatch' });
            expect(sessionKeys()).toEqual([]);
        });

        it('a keychain that refuses the delete does not throw: the refusal still answers', async () => {
            failSecureStore(COOKIE_KEY, 'delete');

            await expect(signInWithEmailCode(EMAIL, CODE, ME)).resolves.toEqual({ kind: 'mismatch' });
            expect(isAccountSwitchHeld(OTHER)).toBe(true);
        });

        it('a non-24-hex expected id is not sent, and the compare still refuses', async () => {
            server.resetHandlers();
            const sent = record('post', SIGN_IN);

            const result = await signInWithEmailCode(EMAIL, CODE, 'not-an-id');

            expect(sent).toEqual([{ email: EMAIL, otp: CODE }]);
            // The mock now signs in the fixture user, who is not "not-an-id".
            expect(result).toEqual({ kind: 'mismatch' });
            expect(isAccountSwitchHeld(ME)).toBe(true);
            expect(sessionKeys()).toEqual([]);
        });
    });

    describe('a server that rejects the unknown field with 400 VALIDATION_ERROR', () => {
        const rejectField = () =>
            http.post(SIGN_IN, async ({ request }) => {
                const body = (await request.clone().json()) as Record<string, any>;
                if (body.expectedUserId) {
                    return HttpResponse.json({ code: 'VALIDATION_ERROR', message: 'VALIDATION_ERROR' }, { status: 400 });
                }
            });

        it('gets one retry without the field and signs the right account in', async () => {
            const sent = record('post', SIGN_IN);
            server.use(rejectField());

            const result = await signInWithEmailCode(EMAIL, CODE, ME);

            expect(result).toEqual({ kind: 'ok', userId: ME });
            // The recorder sits below the rejecting handler, so it saw only the retry.
            expect(sent).toEqual([{ email: EMAIL, otp: CODE }]);
        });

        it('the client compare still refuses when the retry signs in another account', async () => {
            server.use(http.post(SIGN_IN, signInAs(OTHER)));
            const attempts: Record<string, unknown>[] = [];
            server.use(
                http.post(SIGN_IN, async ({ request }) => {
                    const body = (await request.clone().json()) as Record<string, any>;
                    attempts.push(body);
                    if (body.expectedUserId) {
                        return HttpResponse.json({ code: 'VALIDATION_ERROR' }, { status: 400 });
                    }
                }),
            );

            const result = await signInWithEmailCode(EMAIL, CODE, ME);

            expect(attempts).toEqual([{ email: EMAIL, otp: CODE, expectedUserId: ME }, { email: EMAIL, otp: CODE }]);
            expect(result).toEqual({ kind: 'mismatch' });
            expect(isAccountSwitchHeld(OTHER)).toBe(true);
            expect(sessionKeys()).toEqual([]);
        });
    });

    describe('when /sign-out never answers', () => {
        // The refusal waits on authClient.signOut() with no bound of its own, so an unanswered
        // sign-out leaves the sign-in gate on its spinner and the refused cookie in the keychain.
        const NEVER = () => new Promise<Response>(() => {});

        beforeEach(() => {
            useFakeClock(Date.now());
        });

        /** Starts the refusal and gives it `ms` of fake time; resolves with what it returned, if anything. */
        async function refusalWithin(ms: number) {
            server.use(http.post(SIGN_IN, signInAs(OTHER)), http.post(SIGN_OUT, NEVER));
            let result: EmailCodeSignIn | undefined;
            const promise = signInWithEmailCode(EMAIL, CODE, ME).then((r) => (result = r));
            const deadline = new Promise((resolve) => setTimeout(resolve, ms));
            await advanceUntilDone(Promise.race([promise, deadline]), ms + 100);
            return () => result;
        }

        test.failing('B4 the refusal finishes within 6s even when sign-out never answers', async () => {
            const result = await refusalWithin(6000);

            expect(result()).toEqual({ kind: 'mismatch' });
            expect(sessionKeys()).toEqual([]);
        });

        test('B4 today: the refusal is still pending after 6s and the refused cookie is still stored', async () => {
            const result = await refusalWithin(6000);

            expect(result()).toBeUndefined();
            expect(sessionKeys()).toContain(COOKIE_KEY);
            // The hold is taken first, synchronously, so the rest of the app already ignores the account.
            expect(isAccountSwitchHeld(OTHER)).toBe(true);
        });
    });
});
