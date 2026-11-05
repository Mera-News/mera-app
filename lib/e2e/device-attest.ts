// @/modules/mera-device-attest for the E2E build only: metro.config.js resolves the module here when
// EXPO_PUBLIC_E2E=1. Device sign-in is the only way in, a release build never takes the dev bypass,
// and Play Integrity needs Google, so the e2e APK would otherwise show "phone not supported". The
// mock backend accepts any token. The token doubles as the bundle marker scripts/e2e-android.sh
// greps. Exports exactly what lib/device-auth.ts imports; the lane is Android only, so the iOS calls
// reject the way a phone without them does.
const unsupported = async (): Promise<string> => {
    throw Object.assign(new Error('Not on the Android e2e lane'), { code: 'ERR_ATTEST_UNSUPPORTED' });
};

export const isSupported = async (): Promise<boolean> => true;
export const requestIntegrityToken = async (): Promise<string> => 'e2e-fixture-integrity-token';
export const generateKey = unsupported;
export const attestKey = unsupported;
export const generateAssertion = unsupported;
export const isInvalidKeyError = (): boolean => false;
export const isIntegrityUnavailableError = (): boolean => false;
export const isIntegrityTransientError = (): boolean => false;
