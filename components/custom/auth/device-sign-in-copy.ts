// Which sentence tells the truth about a device sign-in, per attestation path.
//
// The copy is keyed on the path `signInWithDevice` will ACTUALLY take
// (lib/device-auth.ts `deviceSignInPath`), not on Platform.OS, because what is
// true differs per path:
//  - only App Attest has Apple checking the app, only Play Integrity has
//    Google checking it, and the staging dev bypass has no platform check at
//    all, so it must not claim one;
//  - the Android UUID fallback (no readable ANDROID_ID) lives in app storage
//    and dies with an uninstall, exactly like the iPhone key, while ANDROID_ID
//    survives a reinstall and is lost only to a reset.
//
// Import-light on purpose (one type import), so each branch is testable
// without mocking Platform.

import type { DeviceSignInFailureReason, DeviceSignInPath } from '@/lib/device-auth';

export type ConsentNoticeKey =
    | 'consent.deviceNotice.appAttest'
    | 'consent.deviceNotice.playIntegrity'
    | 'consent.deviceNotice.generic';

/** The line shown above "Agree and continue". Null when the device cannot
 *  sign in without email at all (the consent step is then unreachable). */
export function consentNoticeKey(path: DeviceSignInPath): ConsentNoticeKey | null {
    switch (path) {
        case 'app-attest':
            return 'consent.deviceNotice.appAttest';
        case 'play-integrity':
        case 'play-integrity-uuid':
            return 'consent.deviceNotice.playIntegrity';
        case 'dev-bypass':
            return 'consent.deviceNotice.generic';
        default:
            return null;
    }
}

/** The line under a failed phone sign-in. A bad connection or a busy server is
 *  temporary; a refusal and an unknown error each have their own line. */
export function deviceFailureKey(reason: DeviceSignInFailureReason) {
    switch (reason) {
        case 'network':
        case 'attestation-unavailable':
            return 'auth.phoneCheckTemporary' as const;
        case 'attestation-denied':
            return 'auth.deviceSignInDenied' as const;
        default:
            return 'auth.deviceSignInFailed' as const;
    }
}

/** The permanent "this phone can't sign in" line, per platform. */
export function phoneUnsupportedKey(os: string) {
    return os === 'ios' ? ('auth.phoneUnsupportedIos' as const) : ('auth.phoneUnsupportedAndroid' as const);
}
