import AbstractGradientBackdrop from '@/components/custom/AbstractGradientBackdrop';
import ErrorBoundary from "@/components/custom/ErrorBoundary";
import { FullScreenErrorFallback } from "@/components/custom/ErrorFallback";
import OnboardingScreen from "@/components/custom/onboarding/OnboardingScreen";
import { Box } from "@/components/ui/box";
import { Spinner } from "@/components/ui/spinner";
import { authClient } from "@/lib/auth-client";
import { Redirect, router } from "expo-router";

export default function Onboarding() {
    const { data: session, isPending } = authClient.useSession();

    // reauth:'1' is load-bearing. The onboarding gate calls this when session
    // and local identity are unresolvably out of sync, and the session is still
    // live — without the param, login.tsx short-circuits on that session and
    // redirects straight back to /logged-in/onboarding, an infinite bounce.
    const handleLoginRedirect = () => {
        router.replace({ pathname: "/login", params: { reauth: "1" } });
    };

    const handleComplete = () => {
        router.replace({
            pathname: "/logged-in/app_container/for_you",
            params: { fromOnboarding: "1" },
        });
    };

    // Show loading screen while checking auth state
    if (isPending) {
        return (
            <Box className="flex-1 justify-center items-center">
                {/* Page background. Must be the FIRST child so it paints behind
                    everything else on the page. */}
                <AbstractGradientBackdrop />

                <Spinner size="large" />
            </Box>
        );
    }

    // If no session, redirect to login
    if (!session) {
        return <Redirect href="/login" />;
    }

    // User is authenticated, show onboarding screen
    return (
        <ErrorBoundary level="screen" FallbackComponent={FullScreenErrorFallback}>
            <OnboardingScreen
                userId={session.user.id}
                onLoginRedirect={handleLoginRedirect}
                onComplete={handleComplete}
            />
        </ErrorBoundary>
    );
}
