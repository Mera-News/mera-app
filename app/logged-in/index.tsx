import { Box } from "@/components/ui/box";
import MeraLogo from "@/components/custom/MeraLogo";
import { OnboardingStage } from "@/lib/generated/graphql-types";
import { authClient } from "@/lib/auth-client";
import { clearPreviousUserData } from "@/lib/stores";
import { getSetting } from "@/lib/database/services/setting-service";
import { useUserStore } from "@/lib/stores/user-store";
import { useNetworkStore } from "@/lib/stores/network-store";
import { useSubscriptionStore } from "@/lib/stores/subscription-store";
import { loginRevenueCat } from "@/lib/revenuecat";
import { router } from "expo-router";
import { useEffect } from "react";

export default function LoggedInIndex() {
    // useSession is a non-blocking enhancement — routing is driven by LOCAL
    // persona state so the app works offline and a dead session never bounces
    // the user out.
    const { data: session } = authClient.useSession();

    useEffect(() => {
        let cancelled = false;

        const determineRoute = async () => {
            // Identity is local-first: the persisted userId survives a dead
            // session. Fall back to a live session id if nothing is persisted yet.
            const localUserId = await getSetting('cached_user_id');
            const userId = session?.user?.id ?? localUserId;

            if (!userId) {
                // No local identity at all — back to the launch gate → login.
                if (!cancelled) {
                    router.dismissAll();
                    router.replace('/');
                }
                return;
            }

            const userStore = useUserStore.getState();

            try {
                // Only a genuinely different signed-in user wipes local data.
                if (session?.user?.id) {
                    await clearPreviousUserData(session.user.id);
                }
                userStore.setUserId(userId);

                // Local-first: hydrate the persisted persona and route on its
                // (possibly stale) onboardingStage immediately — no network.
                await userStore.hydrateFromDb();
                let persona = useUserStore.getState().userPersona;

                const isConnected = useNetworkStore.getState().isConnected;

                if (isConnected) {
                    // Background refresh — must never block routing.
                    void userStore.fetchUserPersona(userId, true);
                    void loginRevenueCat(userId).then((info) => {
                        if (info) useSubscriptionStore.getState().setCustomerInfo(info);
                    });

                    // No cached persona yet (fresh login) — we genuinely can't
                    // know the stage without the server, so wait for it here.
                    if (!persona) {
                        try {
                            persona = await userStore.fetchUserPersonaOrThrow(userId, true);
                        } catch {
                            persona = null;
                        }
                    }
                }

                // Unknown stage (offline with no cache, or a server error) →
                // fall through to the feed rather than trapping a returning user
                // in onboarding.
                const stage = persona?.onboardingStage ?? OnboardingStage.Finished;

                if (cancelled) return;
                if (stage !== OnboardingStage.Finished) {
                    router.replace('/logged-in/onboarding');
                } else {
                    router.replace('/logged-in/app_container/for_you');
                }
            } catch {
                if (!cancelled) router.replace('/logged-in/app_container/for_you');
            }
        };

        determineRoute();

        return () => {
            cancelled = true;
        };
        // Re-run only when the session id changes (login/logout), not on every
        // useSession poll tick.
    }, [session?.user?.id]);

    // Spinner while (and after) routing — the replace() unmounts this screen.
    return (
        <Box className="flex-1 justify-center items-center bg-black">
            <MeraLogo size={96} animated />
        </Box>
    );
}
