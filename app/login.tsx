import ErrorBoundary from "@/components/custom/ErrorBoundary";
import { FullScreenErrorFallback } from "@/components/custom/ErrorFallback";
import AuthScreen from "@/components/custom/auth/AuthScreen";
import { authClient } from "@/lib/auth-client";
import { isAccountSwitchHeld } from "@/lib/security/identity-gate";
import { useReauthSuccess } from "@/components/custom/auth/useReauthSuccess";
import logger from "@/lib/logger";
import { Redirect, useLocalSearchParams } from "expo-router";
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

    const handleReauthSuccess = useReauthSuccess(reauth);

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