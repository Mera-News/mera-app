import ErrorBoundary from "@/components/custom/ErrorBoundary";
import { FullScreenErrorFallback } from "@/components/custom/ErrorFallback";
import AuthScreen from "@/components/custom/auth/AuthScreen";
import { authClient } from "@/lib/auth-client";
import { getSetting } from "@/lib/database/services/setting-service";
import { isAccountSwitchHeld } from "@/lib/security/identity-gate";
import { clearPin } from "@/lib/security/pin-service";
import { usePinStore } from "@/lib/stores/pin-store";
import logger from "@/lib/logger";
import { Redirect, router, useLocalSearchParams } from "expo-router";
import { useEffect, useState } from "react";

export default function LoginScreen() {
    const { data: session, isPending } = authClient.useSession();
    const { reauth, signedOut } = useLocalSearchParams<{ reauth?: string; signedOut?: string }>();
    // Both values mean "re-verify identity, do NOT shortcut on the existing
    // session". They differ only in what may happen AFTER a successful verify:
    // 'pin' came from Forgot PIN and may reset the PIN, '1' came from a session
    // reauth and may not. Leaving 'pin' out of this check would make Forgot PIN
    // short-circuit at the Redirect below and bounce back into the app.
    const reauthMode = reauth === '1' || reauth === 'pin';

    // Arrived here straight from an explicit logout. better-auth does NOT clear
    // its session atom synchronously on signOut(): it toggles $sessionSignal on
    // a 10ms timer and only nulls `data` once /get-session round-trips. For that
    // window `session` still holds the user who just signed out, and the
    // shortcut below would bounce them straight back into the app they left.
    // `isPending` cannot stand in for this — the refetch sets it from
    // `data === null`, so it stays false the whole time stale data is present.
    //
    // The suppression MUST release itself: outside reauth mode AuthScreen gets
    // no onLoginSuccess, so the Redirect below is the ONLY thing that moves a
    // freshly logged-in user off this screen. Release the moment the stale
    // session actually clears — any session after that is a real login.
    //
    // Still needed after the destination change below: /logged-in re-writes
    // `cached_user_id` via setUserId() and re-identifies the user to RevenueCat,
    // so bouncing a just-signed-out user through it is exactly as wrong as it
    // was when this pointed at the onboarding route.
    const [suppressSessionShortcut, setSuppressSessionShortcut] = useState(signedOut === '1');
    useEffect(() => {
        if (suppressSessionShortcut && !session) setSuppressSessionShortcut(false);
    }, [session, suppressSessionShortcut]);


    // Routed through the logger (debug is __DEV__-gated + Sentry-aware) so we
    // don't leak session details to a raw console in any build.
    logger.debug('[Login] useSession', { hasSession: !!session, isPending, reauthMode });

    // In reauth mode (Forgot PIN, or a needs-reauth banner tap) we must NOT
    // shortcut on an existing session — the user has to re-verify OTP to prove
    // identity before the PIN can be reset.
    // ── /logged-in, NOT /logged-in/onboarding ────────────────────────────────
    //
    // Changed 2026-08-06. This used to jump straight to /logged-in/onboarding on
    // a truthy `useSession()` atom — which better-auth is allowed to serve stale
    // — and that skipped EVERY gate in app/logged-in/index.tsx: the
    // session↔local identity check (and its cross-user wipe), the local-fact
    // check that decides whether onboarding is owed at all, and the entitlement
    // resolution that decides paywall vs wizard. A signed-in, fully-onboarded
    // subscriber logging in on this screen was routed to the onboarding gate and
    // had to be bounced back out of it.
    //
    // /logged-in resolves all three and then routes: feed when facts exist,
    // paywall / free-tier / onboarding otherwise. There is no case where jumping
    // past that is right, because this route cannot know which of them applies.
    if (
        session &&
        !isPending &&
        !reauthMode &&
        !suppressSessionShortcut &&
        // "Sign in without email" opened a DIFFERENT account and AuthScreen is
        // asking whether to switch. Shortcutting on that session would route to
        // /logged-in, whose gate wipes this device's account before the user
        // answered. Continue navigates by itself. See holdAccountSwitch.
        !isAccountSwitchHeld(session.user?.id)
    ) {
        logger.debug('[Login] Session found, redirecting to /logged-in');
        return <Redirect href="/logged-in" />;
    }

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

    return (
        <ErrorBoundary level="screen" FallbackComponent={FullScreenErrorFallback}>
            <AuthScreen
                onLoginSuccess={reauthMode ? (userId) => { void handleReauthSuccess(userId); } : undefined}
                // Forgot PIN never offers "Sign in without email": device
                // sign-in proves only that someone holds the phone, which is
                // who the PIN guards against, and a same-account resume here
                // goes straight to clearPin() + /pin-setup. The PARAM is the
                // guard, never usePinStore.lockEnabled (see above).
                allowDeviceSignIn={reauth !== 'pin'}
            />
        </ErrorBoundary>
    );
}
