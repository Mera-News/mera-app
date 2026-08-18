/**
 * Support-id plumbing (lib/support-id.ts): session extraction, the bounded
 * best-effort fetch, and the mailto body builder every support surface uses.
 */

const mockGetSession = jest.fn();
jest.mock('@/lib/auth-client', () => ({
    authClient: { getSession: (...args: unknown[]) => mockGetSession(...args) },
}));

import {
    buildSupportMailtoUrl,
    getSupportId,
    readSupportIdFromUser,
    supportIdLine,
} from '../support-id';

beforeEach(() => {
    jest.clearAllMocks();
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
        mockGetSession.mockResolvedValue({ data: { user: { supportId: '87654321' } } });
        expect(await getSupportId()).toBe('87654321');
    });

    it('resolves null for accounts without one, on error, and on a hang (bounded)', async () => {
        mockGetSession.mockResolvedValue({ data: { user: { email: 'a@b.com' } } });
        expect(await getSupportId()).toBeNull();

        mockGetSession.mockRejectedValue(new Error('offline'));
        expect(await getSupportId()).toBeNull();

        jest.useFakeTimers();
        try {
            mockGetSession.mockImplementation(() => new Promise(() => {}));
            const pending = getSupportId();
            await jest.advanceTimersByTimeAsync(2000);
            expect(await pending).toBeNull();
        } finally {
            jest.useRealTimers();
        }
    });
});

describe('mailto builder', () => {
    it('passes the id through UNCHANGED at any length — no truncation, no padding', () => {
        expect(supportIdLine('1234567')).toBe('Support ID: 1234567');
        expect(supportIdLine('123456789012')).toBe('Support ID: 123456789012');
        expect(decodeURIComponent(buildSupportMailtoUrl('contact@mera.news', '1234567'))).toContain(
            'Support ID: 1234567\n',
        );
    });

    it('pre-fills the body with the Support ID line so the user never copies it', () => {
        expect(supportIdLine('12345678')).toBe('Support ID: 12345678');
        const url = buildSupportMailtoUrl('contact@mera.news', '12345678');
        expect(url).toBe(
            `mailto:contact@mera.news?body=${encodeURIComponent('Support ID: 12345678\n\n')}`,
        );
        expect(decodeURIComponent(url)).toContain('Support ID: 12345678');
    });

    it('falls back to a bare mailto when no id is known', () => {
        expect(buildSupportMailtoUrl('contact@mera.news', null)).toBe('mailto:contact@mera.news');
    });
});
