// Seam test for the legal-consent helpers: needsConsent, the appConfig version fetch through the
// real Apollo client, the /accept-legal POST through the real auth client, and the process latch.
import {
    __resetLegalConsentLatchForTests,
    acceptLegal,
    fetchLegalVersions,
    markLegalAcceptedThisProcess,
    needsConsent,
    silentlyAcceptLegal,
    wasLegalAcceptedThisProcess,
} from '@/components/custom/auth/legal-consent';
import logger from '@/lib/logger';
import { __resetIdentityStateForTests } from '@/lib/security/identity-gate';
import { __resetInstallBoundaryForTests } from '@/lib/security/install-boundary';
import { __resetAuthReadQuarantineForTests, releaseAuthReadQuarantine } from '@/lib/security/install-boundary-latch';
import { appConfig as published } from '@/test/mock-backend/fixtures/graphql/appConfig';
import { HttpResponse, graphql, http, mockGql, mockGqlError, server, signInFixtureAccount } from '@/test/helpers';

const ACCEPT_LEGAL = '*/api/auth/accept-legal';
const CURRENT = { termsVersion: '2026-08-01', privacyVersion: '2026-08-01' };
const appConfig = (v: { termsVersion: string; privacyVersion: string }) =>
    mockGql('LegalConsentAppConfig', { appConfig: { __typename: 'AppConfig', ...v } });

/** Records every /accept-legal body and lets the default handler answer. */
function recordAcceptLegal() {
    const bodies: unknown[] = [];
    server.use(
        http.post(ACCEPT_LEGAL, async ({ request }) => {
            bodies.push(await request.clone().json());
        }),
    );
    return bodies;
}

let captured: jest.SpyInstance;

beforeEach(() => {
    jest.clearAllMocks();
    __resetIdentityStateForTests();
    __resetLegalConsentLatchForTests();
    __resetAuthReadQuarantineForTests();
    __resetInstallBoundaryForTests();
    releaseAuthReadQuarantine();
    captured = jest.spyOn(logger, 'captureException').mockImplementation(() => '');
});

afterEach(() => captured.mockRestore());

describe('needsConsent', () => {
    it('is false when there is no session user (fail open)', () => {
        expect(needsConsent(null, CURRENT)).toBe(false);
        expect(needsConsent(undefined, CURRENT)).toBe(false);
    });

    it('is false when the server config has not resolved yet (fail open)', () => {
        expect(needsConsent({ termsVersion: '2026-08-01', privacyVersion: '2026-08-01' }, null)).toBe(false);
    });

    it('is true when the user has NO consent keys at all (existing users pre-migration)', () => {
        expect(needsConsent({}, CURRENT)).toBe(true);
    });

    it('is true when termsVersion is missing but privacyVersion matches', () => {
        expect(needsConsent({ privacyVersion: '2026-08-01' }, CURRENT)).toBe(true);
    });

    it('is true when privacyVersion is missing but termsVersion matches', () => {
        expect(needsConsent({ termsVersion: '2026-08-01' }, CURRENT)).toBe(true);
    });

    it('is true when termsVersion is present but differs from the current stamp (re-prompt)', () => {
        expect(needsConsent({ termsVersion: '2026-01-01', privacyVersion: '2026-08-01' }, CURRENT)).toBe(true);
    });

    it('is true when privacyVersion is present but differs from the current stamp', () => {
        expect(needsConsent({ termsVersion: '2026-08-01', privacyVersion: '2025-01-01' }, CURRENT)).toBe(true);
    });

    it('is false when both versions match the current stamps', () => {
        expect(needsConsent({ termsVersion: '2026-08-01', privacyVersion: '2026-08-01' }, CURRENT)).toBe(false);
    });
});

describe('fetchLegalVersions', () => {
    it('returns the server appConfig on success', async () => {
        server.use(appConfig(CURRENT));

        await expect(fetchLegalVersions()).resolves.toEqual({ __typename: 'AppConfig', ...CURRENT });
    });

    it('returns the published fixture versions by default', async () => {
        await expect(fetchLegalVersions()).resolves.toMatchObject({
            termsVersion: published.termsVersion,
            privacyVersion: published.privacyVersion,
        });
    });

    it('returns null (not a throw) when the query fails', async () => {
        server.use(mockGqlError('LegalConsentAppConfig', 'INTERNAL_SERVER_ERROR'));

        await expect(fetchLegalVersions()).resolves.toBeNull();
        expect(captured).toHaveBeenCalled();
    });

    it('returns null when the response carries no appConfig', async () => {
        server.use(mockGql('LegalConsentAppConfig', { appConfig: null }));

        await expect(fetchLegalVersions()).resolves.toBeNull();
    });
});

describe('acceptLegal', () => {
    it('posts the version stamps and reports ok on a clean response', async () => {
        await signInFixtureAccount();
        const bodies = recordAcceptLegal();

        await expect(acceptLegal(CURRENT)).resolves.toEqual({ ok: true });

        expect(bodies).toEqual([{ termsVersion: '2026-08-01', privacyVersion: '2026-08-01' }]);
    });

    it('reports NOT ok when the server answers an error, even though the call did not throw', async () => {
        await signInFixtureAccount();
        server.use(http.post(ACCEPT_LEGAL, () => HttpResponse.json({ message: 'boom' }, { status: 500 })));

        await expect(acceptLegal(CURRENT)).resolves.toEqual({ ok: false });
        expect(captured).toHaveBeenCalled();
    });

    it('reports NOT ok when there is no session (the server answers 401)', async () => {
        await expect(acceptLegal(CURRENT)).resolves.toEqual({ ok: false });
        expect(captured).toHaveBeenCalled();
    });

    it('reports NOT ok when the request fails at the network level', async () => {
        await signInFixtureAccount();
        server.use(http.post(ACCEPT_LEGAL, () => HttpResponse.error()));

        await expect(acceptLegal(CURRENT)).resolves.toEqual({ ok: false });
        expect(captured).toHaveBeenCalled();
    });
});

describe('process latch', () => {
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
    it('marks the latch FIRST, then stamps the fetched versions', async () => {
        await signInFixtureAccount();
        let latchedWhenFetched: boolean | undefined;
        server.use(
            // First in line: records the latch as the versions request arrives, then lets the next handler answer.
            graphql.operation(({ operationName }) => {
                if (operationName === 'LegalConsentAppConfig') {
                    latchedWhenFetched = wasLegalAcceptedThisProcess('email-user');
                }
            }),
            appConfig({ termsVersion: 't1', privacyVersion: 'p1' }),
        );
        const bodies = recordAcceptLegal();

        await silentlyAcceptLegal('email-user');

        expect(latchedWhenFetched).toBe(true);
        expect(wasLegalAcceptedThisProcess('email-user')).toBe(true);
        expect(bodies).toEqual([{ termsVersion: 't1', privacyVersion: 'p1' }]);
    });

    it('keeps the latch even when the stamp cannot run (versions fetch fails): suppressed this process, re-derived next launch', async () => {
        await signInFixtureAccount();
        server.use(mockGqlError('LegalConsentAppConfig', 'INTERNAL_SERVER_ERROR'));
        const bodies = recordAcceptLegal();

        await silentlyAcceptLegal('email-user');

        expect(wasLegalAcceptedThisProcess('email-user')).toBe(true);
        expect(bodies).toEqual([]);
    });

    it('never throws, even when the POST fails at the network level', async () => {
        await signInFixtureAccount();
        server.use(appConfig({ termsVersion: 't1', privacyVersion: 'p1' }), http.post(ACCEPT_LEGAL, () => HttpResponse.error()));

        await expect(silentlyAcceptLegal('email-user')).resolves.toBeUndefined();
        expect(wasLegalAcceptedThisProcess('email-user')).toBe(true);
    });
});
