import { Box } from "@/components/ui/box";
import { Spinner } from "@/components/ui/spinner";
import { AccountService } from "@/lib/account-service";
import { OnboardingStage } from "@/lib/generated/graphql-types";
import { authClient } from "@/lib/auth-client";
import { clearPreviousUserData } from "@/lib/stores";
import { useUserStore } from "@/lib/stores/user-store";
import { Redirect, router } from "expo-router";
import { useEffect, useState } from "react";

export default function LoggedInIndex() {
    const { data: session, isPending: isSessionPending } = authClient.useSession();
    const [isCheckingRoute, setIsCheckingRoute] = useState(true);
    const [shouldRedirect, setShouldRedirect] = useState(false);

    useEffect(() => {
        const determineRoute = async () => {
            const userId = session?.user?.id;
            if (!userId) {
                router.dismissAll();
                router.replace('/');
                setIsCheckingRoute(false);
                return;
            }

            try {
                await clearPreviousUserData(userId);

                const userPersona = await AccountService.getUserPersona(userId);

                const userStore = useUserStore.getState();
                userStore.setUserId(userId);
                userStore.setUserPersona(userPersona);

                const stage = userPersona?.onboardingStage ?? OnboardingStage.Notifications;
                const needsOnboarding = stage !== OnboardingStage.Finished;

                if (needsOnboarding) {
                    router.replace('/logged-in/onboarding');
                    return;
                }

                router.replace('/logged-in/app_container/for_you');
            } catch (error: any) {
                const errorMessage = error?.message || '';
                const errorExtensions = error?.graphQLErrors?.[0]?.extensions;
                const statusCode = error?.statusCode || error?.response?.status || error?.networkError?.statusCode;

                if (
                    statusCode === 402 ||
                    errorMessage.includes('NotSubscribedException') ||
                    errorExtensions?.code === 'NOT_SUBSCRIBED' ||
                    errorExtensions?.exception?.name === 'NotSubscribedException'
                ) {
                    router.replace('/logged-in/not-subscribed' as any);
                    return;
                }

                // 401 here used to clear auth and bounce to login — that
                // turned a single transient failure into a forced logout.
                // Now: fall through to for_you on any error. useSession()
                // is the source of truth for "is the user signed in"; if
                // the session is genuinely invalid, the next render cycle
                // will reflect that and the gate above will redirect.
                router.replace('/logged-in/app_container/for_you');
            } finally {
                setShouldRedirect(true);
                setIsCheckingRoute(false);
            }
        };

        if (!isSessionPending && !shouldRedirect) {
            determineRoute();
        }
    }, [session, isSessionPending, shouldRedirect]);

    // Show loading while checking session or route
    if (isSessionPending || isCheckingRoute) {
        return (
            <Box className="flex-1 justify-center items-center bg-black">
                <Spinner size="large" />
            </Box>
        );
    }

    // If a redirect was already initiated (including offline mode), show spinner while navigating
    if (shouldRedirect) {
        return (
            <Box className="flex-1 justify-center items-center bg-black">
                <Spinner size="large" />
            </Box>
        );
    }

    // No session and no local token — redirect to login
    if (!session) {
        return <Redirect href="/login" />;
    }

    // Show spinner while redirecting
    return (
        <Box className="flex-1 justify-center items-center bg-black">
            <Spinner size="large" />
        </Box>
    );
}
