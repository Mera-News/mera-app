import type { AppConfig, AppVersionInfo } from '@/lib/generated/graphql-types';

/** The published legal version stamps (YYYY-MM-DD). `needsConsent` compares the
 *  session user's accepted `termsVersion` / `privacyVersion` against these: a user
 *  stamped with exactly these values is not prompted. */
export const appConfig: AppConfig = {
    __typename: 'AppConfig',
    termsVersion: '2026-01-01',
    privacyVersion: '2026-01-01',
};

/** Floor 0.0.0 keeps the native-update gate open. */
export const appVersionInfo: AppVersionInfo = {
    __typename: 'AppVersionInfo',
    minSupportedVersion: '0.0.0',
    storeUrl: 'https://example.com/store/mera',
};
