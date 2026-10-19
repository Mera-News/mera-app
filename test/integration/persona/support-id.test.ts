// Support-id plumbing (lib/support-id.ts): session extraction, the bounded best-effort fetch, and the mailto
// body builder every support surface uses. getSupportId runs through the real auth-client against MSW.
import { buildSupportMailtoUrl, getSupportId, readSupportIdFromUser, resolveSupportId, supportIdLine } from '@/lib/support-id';
import { advanceUntilDone, delay, http, HttpResponse, server, useFakeClock } from '@/test/helpers';

/** The session as the auth client reads it, with `user` extended by the given fields. */
function sessionUser(extra: Record<string, unknown>) {
    server.use(
        http.get('*/api/auth/get-session', () =>
            HttpResponse.json({
                session: { id: 's1', userId: 'u1', token: 't', expiresAt: '2030-01-01T00:00:00.000Z', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' },
                user: { id: 'u1', email: 'a@b.com', emailVerified: true, name: 'x', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', ...extra },
            }),
        ),
    );
}

beforeEach(() => {
    useFakeClock(Date.UTC(2026, 9, 9, 12, 0, 0));
});

describe('readSupportIdFromUser', () => {
    it('accepts variable-length ids: 7 digits (new mints), 8 (existing), up to 12', () => {
        expect(readSupportIdFromUser({ supportId: '1234567' })).toBe('1234567');
        expect(readSupportIdFromUser({ supportId: '12345678' })).toBe('12345678');
        expect(readSupportIdFromUser({ supportId: '123456789' })).toBe('123456789');
        expect(readSupportIdFromUser({ supportId: '123456' })).toBe('123456');
        expect(readSupportIdFromUser({ supportId: '123456789012' })).toBe('123456789012');
        // Numeric variant tolerated, same bounds.
        expect(readSupportIdFromUser({ supportId: 1234567 })).toBe('1234567');
    });

    it('rejects too short, too long, leading zeros, and non-digits', () => {
        expect(readSupportIdFromUser({ supportId: '12345' })).toBeNull();
        expect(readSupportIdFromUser({ supportId: 12345 })).toBeNull();
        expect(readSupportIdFromUser({ supportId: '1234567890123' })).toBeNull();
        expect(readSupportIdFromUser({ supportId: '01234567' })).toBeNull();
        expect(readSupportIdFromUser(null)).toBeNull();
        expect(readSupportIdFromUser({})).toBeNull();
        expect(readSupportIdFromUser({ supportId: null })).toBeNull();
        expect(readSupportIdFromUser({ supportId: '12ab5678' })).toBeNull();
        expect(readSupportIdFromUser({ supportId: '' })).toBeNull();
        expect(readSupportIdFromUser({ supportId: {} })).toBeNull();
        expect(readSupportIdFromUser({ supportId: -1 })).toBeNull();
    });
});

describe('getSupportId', () => {
    it('reads user.supportId from the session', async () => {
        sessionUser({ supportId: '87654321' });
        expect(await advanceUntilDone(getSupportId())).toBe('87654321');
    });

    it('resolves null for an account without one', async () => {
        sessionUser({});
        expect(await advanceUntilDone(getSupportId())).toBeNull();
    });

    it('resolves null when the session call fails', async () => {
        server.use(http.get('*/api/auth/get-session', () => new HttpResponse(null, { status: 500 })));
        expect(await advanceUntilDone(getSupportId())).toBeNull();
    });

    it('resolves null when the network is down', async () => {
        server.use(http.get('*/api/auth/get-session', () => HttpResponse.error()));
        expect(await advanceUntilDone(getSupportId())).toBeNull();
    });

    it('resolves null on a hang (bounded)', async () => {
        server.use(http.get('*/api/auth/get-session', () => delay('infinite')));
        expect(await advanceUntilDone(getSupportId())).toBeNull();
    });
});

describe('mailto builder', () => {
    it('passes the id through UNCHANGED at any length — no truncation, no padding', () => {
        expect(supportIdLine('1234567')).toBe('Support ID: 1234567');
        expect(supportIdLine('123456789012')).toBe('Support ID: 123456789012');
        expect(decodeURIComponent(buildSupportMailtoUrl('contact@mera.news', '1234567'))).toContain('Support ID: 1234567\n');
    });

    it('pre-fills the body with the Support ID line so the user never copies it', () => {
        expect(supportIdLine('12345678')).toBe('Support ID: 12345678');
        const url = buildSupportMailtoUrl('contact@mera.news', '12345678');
        expect(url).toBe(`mailto:contact@mera.news?body=${encodeURIComponent('Support ID: 12345678\n\n')}`);
        expect(decodeURIComponent(url)).toContain('Support ID: 12345678');
    });

    it('falls back to a bare mailto when no id is known', () => {
        expect(buildSupportMailtoUrl('contact@mera.news', null)).toBe('mailto:contact@mera.news');
    });
});

describe('resolveSupportId', () => {
    it('prefers the session id, so a fresh session always wins over the saved copy', () => {
        expect(resolveSupportId({ supportId: '7654321' }, '1234567')).toBe('7654321');
    });

    it('falls back to the id saved on the phone when there is no session (offline, dead session)', () => {
        expect(resolveSupportId(null, '1234567')).toBe('1234567');
        expect(resolveSupportId({}, '1234567')).toBe('1234567');
    });

    it('validates the saved copy the same way and hides on anything invalid', () => {
        expect(resolveSupportId(null, '01234567')).toBeNull();
        expect(resolveSupportId(null, 'support-1')).toBeNull();
        expect(resolveSupportId(null, null)).toBeNull();
    });
});
