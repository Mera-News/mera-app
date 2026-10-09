import { getSetting } from "@/lib/database/services/setting-service";
import { clearPin } from "@/lib/security/pin-service";
import { usePinStore } from "@/lib/stores/pin-store";
import { router } from "expo-router";

export function useReauthSuccess(reauth: string | undefined) {
    // Reauth: on successful OTP verify, compare the verified user against the
    // locally cached one. THREE outcomes, and the third is the one this used to
    // get wrong.
    //
    // This branched on identity ALONE until 2026-09-17, so every same-user
    // reauth went to /pin-setup — including the three that have nothing to do
    // with the PIN. A user who tapped the "Sign in again to sync" banner was
    // walked into an enrolment they never asked for, and completing it wrote
    // the opt-in flag, after which the launch gate locked them out of their own
    // app on every cold start. The branch was correct for Forgot PIN, where
    // `lockEnabled === true` is a precondition; it was inherited unchanged from
    // the mandatory-PIN era when the lock was made opt-in, because that commit
    // only touched the branch it was looking at.
    //
    // The guard is the PARAM, not usePinStore.lockEnabled: the store defaults
    // to false and depends on init() having run, so gating on it would mean
    // trusting a default. Keying on `reauth === 'pin'` makes the other three
    // producers structurally unable to reach setup, whatever the store says.
    const handleReauthSuccess = async (userId: string) => {
        const cached = await getSetting('cached_user_id');

        // Different user → normal path (logged-in/index wipes local data on a
        // different userId), but the lock is turned off first: clearAllStores
        // does not touch the keychain, so without this the new user would be
        // met by the previous user's PIN screen on the next cold start.
        if (!cached || userId !== cached) {
            await usePinStore.getState().setLockEnabled(false);
            router.replace('/logged-in');
            return;
        }

        // Same user, session reauth (needs-reauth banner, or the identity gate
        // in logged-in/index and onboarding). The PIN is not in question and
        // must not be touched — clearing it here would silently disable the
        // lock for someone who genuinely opted in.
        if (reauth !== 'pin') {
            router.replace('/logged-in');
            return;
        }

        // Same user, Forgot PIN. The opt-in flag is deliberately left ON: they
        // chose the lock, so a forgotten PIN gets replaced rather than silently
        // downgrading their security. /pin-setup offers a Cancel that turns it
        // off if that's what they want. clearPin() runs only HERE, after the
        // decision — running it before the branch destroyed the PIN of anyone
        // who reached this screen and then cancelled.
        await clearPin();
        usePinStore.getState().setPinSet(false);
        router.replace('/pin-setup' as any);
    };

    return handleReauthSuccess;
}
