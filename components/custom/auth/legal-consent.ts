// Legal-consent helpers for ConsentGate — pure predicate + the two network
// calls (server `appConfig` version stamps, and the accept-legal POST).
//
// Kept in `components/custom/auth/` (not `lib/`) because this whole surface
// is owned end-to-end by one item (Item 2a) and has exactly one consumer.

import { gql } from '@apollo/client';
import client from '@/lib/apollo-client';
import { authClient } from '@/lib/auth-client';
import logger from '@/lib/logger';

const APP_CONFIG_QUERY = gql`
  query LegalConsentAppConfig {
    appConfig {
      termsVersion
      privacyVersion
    }
  }
`;

export interface LegalVersions {
    termsVersion: string;
    privacyVersion: string;
}

interface AppConfigResponse {
    appConfig: LegalVersions;
}

/**
 * The subset of the better-auth session user this gate reads. Not part of
 * the generated client types yet (no `additionalFields` config on
 * `authClient` — see `lib/auth-client.ts`), so callers read it off the
 * session with a narrow cast at the call site rather than widening the
 * shared auth-client type for one feature.
 */
export interface ConsentSessionUser {
    termsVersion?: string | null;
    termsAcceptedAt?: string | number | null;
    privacyVersion?: string | null;
    privacyAcceptedAt?: string | number | null;
}

/**
 * Fetches the server's currently-published terms/privacy version stamps.
 * Unguarded on the server ("fetched pre-paywall" per its schema doc), so this
 * never depends on entitlement. Returns `null` on any failure — callers must
 * fail OPEN (never block on a network hiccup), matching NativeUpdateGate's
 * precedent for exactly this kind of best-effort startup check.
 */
export async function fetchLegalVersions(): Promise<LegalVersions | null> {
    try {
        const { data } = await client.query<AppConfigResponse>({
            query: APP_CONFIG_QUERY,
            fetchPolicy: 'no-cache',
        });
        return data?.appConfig ?? null;
    } catch (error) {
        logger.captureException(error, {
            tags: { component: 'legal-consent', method: 'fetchLegalVersions' },
        });
        return null;
    }
}

/**
 * True when the session user's accepted versions are MISSING or DIFFERENT
 * from what the server currently publishes.
 *
 * Existing users have NO consent keys at all (this is a brand-new field), so
 * this branches on "missing or different" — never on a truthy check that
 * assumes the field exists. A brand-new user with no `termsVersion` at all
 * reads exactly the same as a stale one whose version has since bumped: both
 * need the prompt.
 */
export function needsConsent(
    user: ConsentSessionUser | null | undefined,
    current: LegalVersions | null | undefined,
): boolean {
    if (!user || !current) return false;
    const termsOk = !!user.termsVersion && user.termsVersion === current.termsVersion;
    const privacyOk = !!user.privacyVersion && user.privacyVersion === current.privacyVersion;
    return !termsOk || !privacyOk;
}

export interface AcceptLegalResult {
    ok: boolean;
}

/**
 * POSTs acceptance of the given version stamps. better-auth's `$fetch`
 * resolves `{ data, error }` rather than throwing on a non-2xx response, so
 * success is read off the absence of `error`, not off the call merely
 * completing (it can also genuinely throw on a network-level failure, hence
 * the wrapping try/catch too).
 */
export async function acceptLegal(versions: LegalVersions): Promise<AcceptLegalResult> {
    try {
        const { error } = await authClient.$fetch('/accept-legal', {
            method: 'POST',
            body: {
                termsVersion: versions.termsVersion,
                privacyVersion: versions.privacyVersion,
            },
        });
        if (error) {
            logger.captureException(new Error(`accept-legal failed: ${JSON.stringify(error)}`), {
                tags: { component: 'legal-consent', method: 'acceptLegal' },
            });
            return { ok: false };
        }
        return { ok: true };
    } catch (error) {
        logger.captureException(error, {
            tags: { component: 'legal-consent', method: 'acceptLegal' },
        });
        return { ok: false };
    }
}
