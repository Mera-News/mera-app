import { Box } from "@/components/ui/box";
import MeraLogo from "@/components/custom/MeraLogo";
import { AccountService } from "@/lib/account-service";
import { OnboardingStage } from "@/lib/generated/graphql-types";
import { authClient } from "@/lib/auth-client";
import { clearPreviousUserData } from "@/lib/stores";
import { useUserStore } from "@/lib/stores/user-store";
import { useSubscriptionStore } from "@/lib/stores/subscription-store";
import { loginRevenueCat } from "@/lib/revenuecat";
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

                // Identify the RevenueCat customer as this user so the webhook's
                // app_user_id maps back to the same id the server gates on.
                // Fire-and-forget — must not block routing into the app.
                void loginRevenueCat(userId).then((info) => {
                    if (info) useSubscriptionStore.getState().setCustomerInfo(info);
                });

                const stage = userPersona?.onboardingStage ?? OnboardingStage.Notifications;
                const needsOnboarding = stage !== OnboardingStage.Finished;

                if (needsOnboarding) {
                    router.replace('/logged-in/onboarding');
                    return;
                }

                router.replace('/logged-in/app_container/for_you');
            } catch {
                // The subscription paywall is no longer triggered here — the
                // server never gates login/onboarding. It's owned by the For You
                // feed (see article-service), so unsubscribed users still reach
                // the app; the paywall appears when the feed loads (if forced).

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
                <MeraLogo size={96} animated />
            </Box>
        );
    }

    // If a redirect was already initiated (including offline mode), show spinner while navigating
    if (shouldRedirect) {
        return (
            <Box className="flex-1 justify-center items-center bg-black">
                <MeraLogo size={96} animated />
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
            <MeraLogo size={96} animated />
        </Box>
    );
}
