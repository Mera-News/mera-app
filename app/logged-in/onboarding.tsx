import ErrorBoundary from "@/components/custom/ErrorBoundary";
import { FullScreenErrorFallback } from "@/components/custom/ErrorFallback";
import OnboardingScreen from "@/components/custom/onboarding/OnboardingScreen";
import { Box } from "@/components/ui/box";
import { Spinner } from "@/components/ui/spinner";
import { authClient } from "@/lib/auth-client";
import { Redirect, router } from "expo-router";

export default function Onboarding() {
    const { data: session, isPending } = authClient.useSession();

    const handleLoginRedirect = () => {
        router.replace("/login");
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
            <Box className="flex-1 justify-center items-center bg-black">
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
