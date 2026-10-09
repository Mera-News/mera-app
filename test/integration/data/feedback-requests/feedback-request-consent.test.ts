// Seam test for "would ConsentGate be showing for this user?": the real legal-consent helpers and
// Apollo client against MSW's published legal versions. The process latch and the per-user cache
// are module memory, reset around every test.
import {
    __resetFeedbackRequestConsentForTests,
    consentBlocksFeedbackRequest,
} from '@/components/custom/feedback-request/feedback-request-consent';
import {
    __resetLegalConsentLatchForTests,
    markLegalAcceptedThisProcess,
} from '@/components/custom/auth/legal-consent';
import { appConfig } from '@/test/mock-backend/fixtures/graphql/appConfig';
import { mockGql, mockGqlError, server } from '@/test/helpers';
import { failOp, opsNamed, recordOps, resetNetworkAndBanner, setDeviceLink, settleRecorder, spyLogger } from './support';

const CURRENT = { termsVersion: appConfig.termsVersion, privacyVersion: appConfig.privacyVersion };
const STALE_TERMS = { termsVersion: '2025-01-01', privacyVersion: appConfig.privacyVersion };
const STALE_PRIVACY = { termsVersion: appConfig.termsVersion, privacyVersion: '2025-01-01' };
const NEVER_ACCEPTED = {};

const publish = (termsVersion: string, privacyVersion: string) =>
    mockGql('LegalConsentAppConfig', { appConfig: { __typename: 'AppConfig', termsVersion, privacyVersion } });
const fetches = async (sent: ReturnType<typeof recordOps>) => {
    await settleRecorder();
    return opsNamed(sent, 'LegalConsentAppConfig').length;
};

beforeEach(() => {
    __resetFeedbackRequestConsentForTests();
    __resetLegalConsentLatchForTests();
    resetNetworkAndBanner();
});

describe('consentBlocksFeedbackRequest', () => {
    it('is clear for a user on the current versions', async () => {
        await expect(consentBlocksFeedbackRequest('u1', CURRENT)).resolves.toBe(false);
    });

    it.each([
        ['stale terms', STALE_TERMS],
        ['stale privacy', STALE_PRIVACY],
        ['never accepted', NEVER_ACCEPTED],
    ])('blocks a user with %s, and asks again every time', async (_label, user) => {
        const sent = recordOps();
        await expect(consentBlocksFeedbackRequest('u1', user)).resolves.toBe(true);
        await expect(consentBlocksFeedbackRequest('u1', user)).resolves.toBe(true);
        expect(await fetches(sent)).toBe(2);
    });

    it('blocks when the server publishes newer legal versions than the user accepted', async () => {
        server.use(publish('2027-01-01', '2027-01-01'));
        await expect(consentBlocksFeedbackRequest('u1', CURRENT)).resolves.toBe(true);
    });

    it('is not blocked for a missing session user: needsConsent has nothing to compare', async () => {
        await expect(consentBlocksFeedbackRequest('u1', null)).resolves.toBe(false);
        await expect(consentBlocksFeedbackRequest('u1', undefined)).resolves.toBe(false);
    });

    it('caches a clear answer per user, so the second call does not fetch', async () => {
        const sent = recordOps();
        await expect(consentBlocksFeedbackRequest('u1', CURRENT)).resolves.toBe(false);
        await expect(consentBlocksFeedbackRequest('u1', CURRENT)).resolves.toBe(false);
        expect(await fetches(sent)).toBe(1);
    });

    it('does not carry one user’s cached clear to another', async () => {
        const sent = recordOps();
        await expect(consentBlocksFeedbackRequest('u1', CURRENT)).resolves.toBe(false);
        await expect(consentBlocksFeedbackRequest('u2', STALE_TERMS)).resolves.toBe(true);
        expect(await fetches(sent)).toBe(2);
    });

    it('a cached clear holds even if the server later publishes newer versions', async () => {
        await consentBlocksFeedbackRequest('u1', CURRENT);
        server.use(publish('2027-01-01', '2027-01-01'));
        await expect(consentBlocksFeedbackRequest('u1', CURRENT)).resolves.toBe(false);
    });

    it('is clear without a fetch when this process already recorded the acceptance', async () => {
        markLegalAcceptedThisProcess('u1');
        const sent = recordOps();
        await expect(consentBlocksFeedbackRequest('u1', STALE_TERMS)).resolves.toBe(false);
        expect(await fetches(sent)).toBe(0);
    });

    it('the process latch is per user', async () => {
        markLegalAcceptedThisProcess('u1');
        await expect(consentBlocksFeedbackRequest('u2', STALE_TERMS)).resolves.toBe(true);
    });

    it('fails open when the versions endpoint answers with an error, and does not cache that', async () => {
        const logs = spyLogger();
        server.use(mockGqlError('LegalConsentAppConfig', 'INTERNAL_SERVER_ERROR'));
        await expect(consentBlocksFeedbackRequest('u1', STALE_TERMS)).resolves.toBe(false);
        expect(logs.capture).toHaveBeenCalled();

        server.resetHandlers();
        await expect(consentBlocksFeedbackRequest('u1', STALE_TERMS)).resolves.toBe(true);
    });

    it('fails open when the versions endpoint is unreachable', async () => {
        spyLogger();
        setDeviceLink(false);
        server.use(failOp('LegalConsentAppConfig'));
        await expect(consentBlocksFeedbackRequest('u1', STALE_TERMS)).resolves.toBe(false);
    });

    it('fails open when the answer carries no appConfig', async () => {
        server.use(mockGql('LegalConsentAppConfig', { appConfig: null }));
        await expect(consentBlocksFeedbackRequest('u1', STALE_TERMS)).resolves.toBe(false);
    });
});
