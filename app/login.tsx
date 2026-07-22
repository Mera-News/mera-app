import ErrorBoundary from "@/components/custom/ErrorBoundary";
import { FullScreenErrorFallback } from "@/components/custom/ErrorFallback";
import AuthScreen from "@/components/custom/auth/AuthScreen";
import { authClient } from "@/lib/auth-client";
import { getSetting } from "@/lib/database/services/setting-service";
import { clearPin } from "@/lib/security/pin-service";
import { usePinStore } from "@/lib/stores/pin-store";
import logger from "@/lib/logger";
import { Redirect, router, useLocalSearchParams } from "expo-router";

export default function LoginScreen() {
    const { data: session, isPending } = authClient.useSession();
    const { reauth } = useLocalSearchParams<{ reauth?: string }>();
    const reauthMode = reauth === '1';

    // Routed through the logger (debug is __DEV__-gated + Sentry-aware) so we
    // don't leak session details to a raw console in any build.
    logger.debug('[Login] useSession', { hasSession: !!session, isPending, reauthMode });

    // In reauth mode (Forgot PIN, or a needs-reauth banner tap) we must NOT
    // shortcut on an existing session — the user has to re-verify OTP to prove
    // identity before the PIN can be reset.
    if (session && !isPending && !reauthMode) {
        logger.debug('[Login] Session found, redirecting to /logged-in/onboarding');
        return <Redirect href="/logged-in/onboarding" />;
    }

    // Reauth: on successful OTP verify, compare the verified user against the
    // locally cached one. Same user → reset the PIN, keep all local data.
    // Different user → normal path (logged-in/index wipes local data on a
    // different userId).
    const handleReauthSuccess = async (userId: string) => {
        const cached = await getSetting('cached_user_id');
        if (cached && userId === cached) {
            await clearPin();
            usePinStore.getState().setPinSet(false);
            router.replace('/pin-setup' as any);
        } else {
            router.replace('/logged-in');
        }
    };

    return (
        <ErrorBoundary level="screen" FallbackComponent={FullScreenErrorFallback}>
            <AuthScreen
                onLoginSuccess={reauthMode ? (userId) => { void handleReauthSuccess(userId); } : undefined}
            />
        </ErrorBoundary>
    );
}
