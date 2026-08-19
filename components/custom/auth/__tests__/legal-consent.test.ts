// legal-consent (B6, Item 2a) — verifies:
//  • needsConsent branches on MISSING or MISMATCHED versions, never on a
//    truthy check that assumes the fields exist (existing users have none at
//    all — the exact case this guards against);
//  • fetchLegalVersions resolves the server's appConfig and fails to null,
//    never throws, on any network/query error;
//  • acceptLegal reads success off the ABSENCE of `error` in $fetch's
//    `{data, error}` result (better-auth's $fetch does not throw on a
//    non-2xx response), and also survives a genuine throw.

const mockQuery = jest.fn();
jest.mock('@/lib/apollo-client', () => ({
    __esModule: true,
    default: { query: (...args: unknown[]) => mockQuery(...args) },
}));

const mockFetch = jest.fn();
jest.mock('@/lib/auth-client', () => ({
    authClient: { $fetch: (...args: unknown[]) => mockFetch(...args) },
}));

jest.mock('@/lib/logger', () => ({
    __esModule: true,
    default: { captureException: jest.fn() },
}));

import logger from '@/lib/logger';
import {
    __resetLegalConsentLatchForTests,
    acceptLegal, fetchLegalVersions, markLegalAcceptedThisProcess, needsConsent,
    silentlyAcceptLegal, wasLegalAcceptedThisProcess,
} from '../legal-consent';

describe('needsConsent', () => {
    const current = { termsVersion: '2026-08-01', privacyVersion: '2026-08-01' };

    it('is false when there is no session user (fail open)', () => {
        expect(needsConsent(null, current)).toBe(false);
        expect(needsConsent(undefined, current)).toBe(false);
    });

    it('is false when the server config has not resolved yet (fail open)', () => {
        expect(needsConsent({ termsVersion: '2026-08-01', privacyVersion: '2026-08-01' }, null)).toBe(false);
    });

    it('is true when the user has NO consent keys at all (existing users pre-migration)', () => {
        expect(needsConsent({}, current)).toBe(true);
    });

    it('is true when termsVersion is missing but privacyVersion matches', () => {
        expect(needsConsent({ privacyVersion: '2026-08-01' }, current)).toBe(true);
    });

    it('is true when privacyVersion is missing but termsVersion matches', () => {
        expect(needsConsent({ termsVersion: '2026-08-01' }, current)).toBe(true);
    });

    it('is true when termsVersion is present but differs from the current stamp (re-prompt)', () => {
        expect(
            needsConsent({ termsVersion: '2026-01-01', privacyVersion: '2026-08-01' }, current),
        ).toBe(true);
    });

    it('is true when privacyVersion is present but differs from the current stamp', () => {
        expect(
            needsConsent({ termsVersion: '2026-08-01', privacyVersion: '2025-01-01' }, current),
        ).toBe(true);
    });

    it('is false when both versions match the current stamps', () => {
        expect(
            needsConsent({ termsVersion: '2026-08-01', privacyVersion: '2026-08-01' }, current),
        ).toBe(false);
    });
});

describe('fetchLegalVersions', () => {
    beforeEach(() => jest.clearAllMocks());

    it('returns the server appConfig on success', async () => {
        mockQuery.mockResolvedValue({
            data: { appConfig: { termsVersion: '2026-08-01', privacyVersion: '2026-08-01' } },
        });
        const result = await fetchLegalVersions();
        expect(result).toEqual({ termsVersion: '2026-08-01', privacyVersion: '2026-08-01' });
    });

    it('returns null (not a throw) when the query rejects', async () => {
        mockQuery.mockRejectedValue(new Error('network down'));
        const result = await fetchLegalVersions();
        expect(result).toBeNull();
        expect(logger.captureException).toHaveBeenCalled();
    });

    it('returns null when the response carries no appConfig', async () => {
        mockQuery.mockResolvedValue({ data: undefined });
        const result = await fetchLegalVersions();
        expect(result).toBeNull();
    });
});

describe('acceptLegal', () => {
    const versions = { termsVersion: '2026-08-01', privacyVersion: '2026-08-01' };

    beforeEach(() => jest.clearAllMocks());

    it('posts the version stamps and reports ok on a clean {data, error:null} response', async () => {
        mockFetch.mockResolvedValue({ data: { success: true }, error: null });
        const result = await acceptLegal(versions);
        expect(result).toEqual({ ok: true });
        expect(mockFetch).toHaveBeenCalledWith('/accept-legal', {
            method: 'POST',
            body: { termsVersion: '2026-08-01', privacyVersion: '2026-08-01' },
        });
    });

    it('reports NOT ok when $fetch resolves an `error` field, even though the call did not throw', async () => {
        mockFetch.mockResolvedValue({ data: null, error: { status: 500, message: 'boom' } });
        const result = await acceptLegal(versions);
        expect(result).toEqual({ ok: false });
        expect(logger.captureException).toHaveBeenCalled();
    });

    it('reports NOT ok when $fetch genuinely throws (network-level failure)', async () => {
        mockFetch.mockRejectedValue(new Error('offline'));
        const result = await acceptLegal(versions);
        expect(result).toEqual({ ok: false });
        expect(logger.captureException).toHaveBeenCalled();
    });
});

describe('process latch', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        __resetLegalConsentLatchForTests();
    });

    it('is per-user: marking one user does not suppress another', () => {
        markLegalAcceptedThisProcess('u1');
        expect(wasLegalAcceptedThisProcess('u1')).toBe(true);
        expect(wasLegalAcceptedThisProcess('u2')).toBe(false);
    });

    it('answers false for null/undefined ids (an unresolved session never counts as accepted)', () => {
        markLegalAcceptedThisProcess('u1');
        expect(wasLegalAcceptedThisProcess(null)).toBe(false);
        expect(wasLegalAcceptedThisProcess(undefined)).toBe(false);
    });
});

describe('silentlyAcceptLegal (email path)', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        __resetLegalConsentLatchForTests();
    });

    it('marks the latch FIRST, then stamps the fetched versions', async () => {
        mockQuery.mockResolvedValue({
            data: { appConfig: { termsVersion: 't1', privacyVersion: 'p1' } },
        });
        mockFetch.mockResolvedValue({ data: { ok: true }, error: null });

        await silentlyAcceptLegal('email-user');

        expect(wasLegalAcceptedThisProcess('email-user')).toBe(true);
        expect(mockFetch).toHaveBeenCalledWith('/accept-legal', expect.objectContaining({
            method: 'POST',
            body: { termsVersion: 't1', privacyVersion: 'p1' },
        }));
    });

    it('keeps the latch even when the stamp cannot run (versions fetch fails) — suppressed this process, re-derived next launch', async () => {
        mockQuery.mockRejectedValue(new Error('offline'));

        await silentlyAcceptLegal('email-user');

        expect(wasLegalAcceptedThisProcess('email-user')).toBe(true);
        expect(mockFetch).not.toHaveBeenCalled();
    });

    it('never throws, even when the POST rejects at the network level', async () => {
        mockQuery.mockResolvedValue({
            data: { appConfig: { termsVersion: 't1', privacyVersion: 'p1' } },
        });
        mockFetch.mockRejectedValue(new Error('offline'));

        await expect(silentlyAcceptLegal('email-user')).resolves.toBeUndefined();
        expect(wasLegalAcceptedThisProcess('email-user')).toBe(true);
    });
});
