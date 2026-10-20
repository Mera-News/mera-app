// Mock auth service: better-auth (email OTP, session, jwt, sign-out) plus the app's own
// auth routes, all under the better-auth basePath /api/auth. One in-memory session map;
// the OTP is fixed, so no code is ever stored.
import { createHmac, randomBytes } from 'node:crypto';
import { http, HttpResponse, type RequestHandler } from 'msw';
import { FIXTURE_ACCOUNT } from './fixtures/account';
import { appConfig } from './fixtures/graphql/appConfig';

const COOKIE = 'better-auth.session_token';
const DAY_MS = 86_400_000;
// Any value works: nothing here verifies a signature, the cookie only has to look signed.
const SIGNING_SECRET = 'e2e-mock-secret';

interface Session {
    id: string;
    token: string;
    createdAt: string;
    expiresAt: string;
}

const sessions = new Map<string, Session>();
let lastOtpEmail: string | null = null;

export function resetAuthState(): void {
    sessions.clear();
    lastOtpEmail = null;
}

/** The email the last send-verification-otp call was for. */
export const getLastOtpEmail = (): string | null => lastOtpEmail;

const b64url = (v: string | Buffer) => Buffer.from(v).toString('base64url');

function mintSession(): Session {
    const now = new Date();
    const s: Session = {
        id: b64url(randomBytes(9)),
        token: b64url(randomBytes(24)),
        createdAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + 30 * DAY_MS).toISOString(),
    };
    sessions.set(s.token, s);
    return s;
}

/** better-auth's signed cookie value: `<token>.<base64 HMAC>`, URL-encoded. */
const cookieValue = (token: string) =>
    encodeURIComponent(`${token}.${createHmac('sha256', SIGNING_SECRET).update(token).digest('base64')}`);

const user = (s: Session) => ({
    id: FIXTURE_ACCOUNT.userId,
    email: FIXTURE_ACCOUNT.email,
    emailVerified: true,
    name: FIXTURE_ACCOUNT.name,
    image: null,
    // The fixture user has accepted the published legal versions, so ConsentGate
    // (components/custom/auth/legal-consent.ts needsConsent) does not prompt.
    termsVersion: appConfig.termsVersion,
    termsAcceptedAt: s.createdAt,
    privacyVersion: appConfig.privacyVersion,
    privacyAcceptedAt: s.createdAt,
    createdAt: s.createdAt,
    updatedAt: s.createdAt,
});

const sessionBody = (s: Session) => ({
    session: {
        id: s.id,
        userId: FIXTURE_ACCOUNT.userId,
        token: s.token,
        expiresAt: s.expiresAt,
        createdAt: s.createdAt,
        updatedAt: s.createdAt,
    },
    user: user(s),
});

/** Session from the cookie (the expo client sends `; name=value`) or `Authorization: Bearer`. */
function sessionOf(request: Request): Session | undefined {
    let raw = request.headers.get('cookie')?.match(new RegExp(`(?:^|[;\\s])${COOKIE}=([^;\\s]+)`))?.[1];
    if (raw) raw = decodeURIComponent(raw);
    else raw = request.headers.get('authorization')?.match(/^Bearer (.+)$/i)?.[1];
    return raw ? sessions.get(raw.split('.')[0]) : undefined;
}

/** The session cookie; no token clears it. */
const setCookie = (token?: string) =>
    `${COOKIE}=${token ? cookieValue(token) : ''}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${
        token ? (30 * DAY_MS) / 1000 : 0
    }`;

/**
 * A JSON response carrying `set-cookie`. Deliberately a plain Response, not HttpResponse:
 * msw copies an HttpResponse's cookies into a jar that it replays on every later request,
 * so the session would reach the server whether or not the app's storage returned the cookie.
 */
const jsonWithCookie = (body: unknown, cookie: string) =>
    new Response(JSON.stringify(body), {
        headers: { 'content-type': 'application/json', 'set-cookie': cookie },
    });

const error = (status: number, code: string, message = code) =>
    HttpResponse.json({ code, message }, { status });

const bodyOf = async (request: Request): Promise<Record<string, any>> => {
    try {
        return (await request.json()) ?? {};
    } catch {
        return {};
    }
};

/** Mints a session and answers in better-auth's sign-in shape, with the cookie. */
function signedIn(extra: Record<string, unknown> = {}) {
    const s = mintSession();
    return jsonWithCookie({ redirect: false, token: s.token, user: user(s), ...extra }, setCookie(s.token));
}

/** Unsigned-shaped JWT: the app reads it as an opaque bearer, the gateway mock only checks the shape. */
function jwt(): string {
    const iat = Math.floor(Date.now() / 1000);
    return [
        b64url(JSON.stringify({ alg: 'none', typ: 'JWT' })),
        b64url(JSON.stringify({ sub: FIXTURE_ACCOUNT.userId, email: FIXTURE_ACCOUNT.email, iat, exp: iat + 3600 })),
        'e2e',
    ].join('.');
}

export const authHandlers: RequestHandler[] = [
    http.post('*/api/auth/email-otp/send-verification-otp', async ({ request }) => {
        lastOtpEmail = (await bodyOf(request)).email ?? null;
        return HttpResponse.json({ success: true });
    }),

    http.post('*/api/auth/sign-in/email-otp', async ({ request }) => {
        const { email, otp, expectedUserId } = await bodyOf(request);
        if (typeof email !== 'string' || !email.includes('@')) return error(400, 'VALIDATION_ERROR');
        if (otp !== FIXTURE_ACCOUNT.otp) return error(400, 'INVALID_OTP', 'Invalid OTP');
        if (expectedUserId && expectedUserId !== FIXTURE_ACCOUNT.userId) {
            return error(409, 'REAUTH_ACCOUNT_MISMATCH');
        }
        return signedIn();
    }),

    http.get('*/api/auth/get-session', ({ request }) => {
        const s = sessionOf(request);
        return HttpResponse.json(s ? sessionBody(s) : null);
    }),

    // authClient.token(): better-auth's jwt plugin.
    http.get('*/api/auth/token', ({ request }) => {
        const s = sessionOf(request);
        return s ? HttpResponse.json({ token: jwt() }) : error(401, 'UNAUTHORIZED');
    }),

    http.post('*/api/auth/sign-out', ({ request }) => {
        const s = sessionOf(request);
        if (s) sessions.delete(s.token);
        return jsonWithCookie({ success: true }, setCookie());
    }),

    // Device routes: no session check, as the real ones mint the session themselves.
    http.post('*/api/auth/device/nonce', () =>
        HttpResponse.json({ nonce: b64url(randomBytes(32)) }),
    ),
    http.post('*/api/auth/device/sign-in/:platform', () =>
        signedIn({ trialAvailable: false, minted: false }),
    ),
    http.post('*/api/auth/device/attest/ios', () => HttpResponse.json({ ok: true })),
    // Test accounts (dev builds only; the e2e release build never calls them).
    http.post('*/api/auth/test-account/sign-in', () => signedIn({ trialAvailable: false, minted: false })),
    http.post('*/api/auth/test-account/delete', () => HttpResponse.json({ status: 'deleted' })),
    http.post('*/api/auth/test-account/list', () => HttpResponse.json({ accounts: [] })),
    http.post('*/api/auth/device/email/request', () => HttpResponse.json({ ok: true })),
    http.post('*/api/auth/device/email/confirm', async ({ request }) =>
        (await bodyOf(request)).otp === FIXTURE_ACCOUNT.otp
            ? HttpResponse.json({ ok: true })
            : error(400, 'INVALID_OTP'),
    ),

    // The app's own routes (called through authClient.$fetch, so under the basePath).
    http.post('*/api/auth/accept-legal', ({ request }) =>
        sessionOf(request) ? HttpResponse.json({ ok: true }) : error(401, 'UNAUTHORIZED'),
    ),
    http.post('*/api/auth/request-account-deletion', ({ request }) =>
        sessionOf(request) ? HttpResponse.json({ ok: true }) : error(401, 'UNAUTHORIZED'),
    ),
    // network-store PROBE_PATH
    http.get('*/api/auth/ok', () => HttpResponse.json({ ok: true })),
];
