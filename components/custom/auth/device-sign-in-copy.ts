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

import type { DeviceSignInPath } from '@/lib/device-auth';

export type ConsentNoticeKey =
    | 'consent.deviceNotice.appAttest'
    | 'consent.deviceNotice.playIntegrity'
    | 'consent.deviceNotice.generic';

export type DeviceSignInCaptionKey =
    | 'auth.deviceSignInCaption.uninstall'
    | 'auth.deviceSignInCaption.reset';

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

/** The consequence caption under "Sign in without email": what loses the
 *  account. Only ANDROID_ID survives an uninstall. */
export function deviceSignInCaptionKey(path: DeviceSignInPath): DeviceSignInCaptionKey | null {
    switch (path) {
        case 'play-integrity':
            return 'auth.deviceSignInCaption.reset';
        case 'app-attest':
        case 'play-integrity-uuid':
        case 'dev-bypass':
            return 'auth.deviceSignInCaption.uninstall';
        default:
            return null;
    }
}
