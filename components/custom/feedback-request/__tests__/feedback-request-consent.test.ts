// feedback-request-consent: the ConsentGate predicate, failing open, with a
// per-user cache of the "no consent needed" answer only.

let mockVersions: any = { termsVersion: '2', privacyVersion: '2' };
let mockLatched = false;
const mockFetch = jest.fn(async () => mockVersions);
jest.mock('@/components/custom/auth/legal-consent', () => ({
  fetchLegalVersions: () => mockFetch(),
  needsConsent: (u: any, v: any) => !!u && !!v && (u.termsVersion !== v.termsVersion || u.privacyVersion !== v.privacyVersion),
  wasLegalAcceptedThisProcess: () => mockLatched,
}));

import { __resetFeedbackRequestConsentForTests, consentBlocksFeedbackRequest } from '../feedback-request-consent';

const CURRENT = { termsVersion: '2', privacyVersion: '2' };
const STALE = { termsVersion: '1', privacyVersion: '2' };

beforeEach(() => {
  __resetFeedbackRequestConsentForTests();
  mockVersions = { termsVersion: '2', privacyVersion: '2' };
  mockLatched = false;
  mockFetch.mockClear();
});

it('blocks while the account has not accepted the current versions, asking every time', async () => {
  await expect(consentBlocksFeedbackRequest('u1', STALE)).resolves.toBe(true);
  await expect(consentBlocksFeedbackRequest('u1', STALE)).resolves.toBe(true);
  expect(mockFetch).toHaveBeenCalledTimes(2);
});

it('clear once accepted, and caches that per user', async () => {
  await expect(consentBlocksFeedbackRequest('u1', CURRENT)).resolves.toBe(false);
  await expect(consentBlocksFeedbackRequest('u1', CURRENT)).resolves.toBe(false);
  expect(mockFetch).toHaveBeenCalledTimes(1);
  await expect(consentBlocksFeedbackRequest('u2', STALE)).resolves.toBe(true);
});

it('clear when this process already recorded acceptance, without a fetch', async () => {
  mockLatched = true;
  await expect(consentBlocksFeedbackRequest('u1', STALE)).resolves.toBe(false);
  expect(mockFetch).not.toHaveBeenCalled();
});

it('fails open when the versions cannot be fetched, and does not cache that', async () => {
  mockVersions = null;
  await expect(consentBlocksFeedbackRequest('u1', STALE)).resolves.toBe(false);
  mockVersions = { termsVersion: '2', privacyVersion: '2' };
  await expect(consentBlocksFeedbackRequest('u1', STALE)).resolves.toBe(true);
});
