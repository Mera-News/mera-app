import { getSetting } from "@/lib/database/services/setting-service";
import { clearPin } from "@/lib/security/pin-service";
import { usePinStore } from "@/lib/stores/pin-store";
import { router } from "expo-router";

export function useReauthSuccess(reauth: string | undefined) {
    // On a successful OTP verify, compare the verified user with the locally
    // cached one. Only Forgot PIN (`reauth === 'pin'`) may reach /pin-setup:
    // finishing setup writes the opt-in flag, so sending any other reauth there
    // would lock the user out on every cold start.
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
