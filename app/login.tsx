import ErrorBoundary from "@/components/custom/ErrorBoundary";
import { FullScreenErrorFallback } from "@/components/custom/ErrorFallback";
import AuthScreen from "@/components/custom/auth/AuthScreen";
import { authClient } from "@/lib/auth-client";
import logger from "@/lib/logger";
import { Redirect } from "expo-router";

export default function LoginScreen() {
    const { data: session, isPending } = authClient.useSession();

    // Routed through the logger (debug is __DEV__-gated + Sentry-aware) so we
    // don't leak session details to a raw console in any build.
    logger.debug('[Login] useSession', { hasSession: !!session, isPending });

    // If user is already authenticated, redirect to onboarding check
    if (session && !isPending) {
        logger.debug('[Login] Session found, redirecting to /logged-in/onboarding');
        return <Redirect href="/logged-in/onboarding" />;
    }

    // Show login screen
    return (
        <ErrorBoundary level="screen" FallbackComponent={FullScreenErrorFallback}>
            <AuthScreen onLoginSuccess={() => { }} />
        </ErrorBoundary>
    );
}
