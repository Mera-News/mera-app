// The silent bind. Once per device and account, at launch: bind this phone to
// an account that signed in with email (before email sign-in was removed)
// WITHOUT moving it, so it keeps signing in with this phone now that every
// email is deleted. A pure phone account is skipped: it signed in with this
// phone's own key, so it is bound by construction, and skipping it spares an
// attestation call per install. Background only: no UI, never blocks, never
// signs anyone out; a failure or an unsupported phone simply tries again next
// launch.
//
// Import-light: the settings table and the device sign-in client are required
// lazily, at the call.

import logger from '@/lib/logger';

export const DEVICE_BOUND_SETTING_KEY = 'device_bound_user';

/** The one place the legacy `cached_user_email` row is still read: an email
 *  sign-in wrote it, so a real address there marks a former email account.
 *  New devices never write it. Never throws; unsure reads false. */
async function signedInWithEmail(): Promise<boolean> {
    try {
        const { getSetting } =
            require('@/lib/database/services/setting-service') as typeof import('@/lib/database/services/setting-service');
        const { emailLooksAnonymous } =
            require('@/lib/subscription/email-capture') as typeof import('@/lib/subscription/email-capture');
        return !emailLooksAnonymous(await getSetting('cached_user_email'));
    } catch {
        return false;
    }
}

let bindInFlight: Promise<void> | null = null;

export function bindPhoneOnce(userId: string): Promise<void> {
    if (!userId) return Promise.resolve();
    if (bindInFlight) return bindInFlight;
    bindInFlight = (async () => {
        try {
            const { getSetting, setSetting } =
                require('@/lib/database/services/setting-service') as typeof import('@/lib/database/services/setting-service');
            if ((await getSetting(DEVICE_BOUND_SETTING_KEY)) === userId) return;
            if (!(await signedInWithEmail())) return;
            const { convertWithDevice } = require('@/lib/device-auth') as typeof import('@/lib/device-auth');
            const result = await convertWithDevice(undefined, { bindOnly: true });
            if (result.status === 'unsupported' || result.status === 'failed') return;
            await setSetting(DEVICE_BOUND_SETTING_KEY, userId);
        } catch (error) {
            logger.warn('[bind-phone] silent bind failed', { error: String(error) });
        } finally {
            bindInFlight = null;
        }
    })();
    return bindInFlight;
}

/** Test seam. */
export function __resetBindPhoneForTests(): void {
    bindInFlight = null;
}
