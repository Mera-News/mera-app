import { Box } from "@/components/ui/box";
import MeraLogo from "@/components/custom/MeraLogo";
import { authClient } from "@/lib/auth-client";
import { clearPreviousUserData } from "@/lib/stores";
import { hasAnyFacts } from "@/lib/database/services/fact-service";
import { getSetting } from "@/lib/database/services/setting-service";
import { hasIdentityFault, resolveIdentity } from "@/lib/security/identity-gate";
import { useUserStore } from "@/lib/stores/user-store";
import { probeServerReachable, useNetworkStore } from "@/lib/stores/network-store";
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
                // Resolve session <-> local-identity coherence BEFORE anything
                // reads persona/facts or fires a personalized query. A mismatch
                // that reaches the shell surfaces as a 403 per query
                // ("resource belongs to another user"), which is exactly what
                // this gate exists to prevent. Same helper as the onboarding
                // gate so the two can't drift.
                const ownershipFault = await hasIdentityFault();
                const isConnected = useNetworkStore.getState().isConnected;
                // Probe ONLY when it can change the outcome. The fault path is
                // rare; the happy path must not pay a round-trip on every cold
                // start. Bounded at 3s inside probeServerReachable().
                const serverReachable =
                    ownershipFault && isConnected ? await probeServerReachable() : undefined;

                const verdict = resolveIdentity({
                    sessionUserId: session?.user?.id,
                    cachedUserId: localUserId,
                    ownershipFault,
                    isConnected,
                    serverReachable,
                });

                if (verdict === 'reauth') {
                    // Unresolvable locally — OTP is the only way to learn which
                    // side is stale. reauth:'1' is load-bearing: without it
                    // login.tsx short-circuits on the existing session and
                    // bounces straight back here.
                    if (!cancelled) {
                        router.replace({ pathname: '/login', params: { reauth: '1' } });
                    }
                    return;
                }

                if (verdict === 'wipeAndProceed' && session?.user?.id) {
                    await clearPreviousUserData(session.user.id);
                }
                userStore.setUserId(userId);

                // DEFERRED FAULT. We chose not to eject because re-auth is
                // unreachable, but the fault is still unresolved — so keep every
                // authenticated background task off until it is. AppScheduler's
                // auth pre-flight returns false on needsReauth, which is what
                // actually stops feed-sync.
                //
                // Ordering: this MUST come after clearPreviousUserData above,
                // which resets the user store (zeroing needsReauth). And it is
                // not redundant with the flag recordOwnershipFault already set:
                // recordAuthSuccess clears needsReauth on ANY error-free
                // operation, including unauthenticated ones that prove nothing
                // about the userId the 403 was about. Only OTP success clears
                // the persisted fault itself.
                if (ownershipFault) {
                    userStore.setNeedsReauth(true);
                }

                // Local-first: hydrate the persisted persona. It no longer
                // decides the route (see the fact gate below) but downstream
                // screens read it, so keep it warm.
                await userStore.hydrateFromDb();
                const persona = useUserStore.getState().userPersona;

                // Deliberately re-read rather than reusing the value from the
                // identity gate above: several awaits have happened since, and
                // connectivity may have changed under them.
                const isConnectedNow = useNetworkStore.getState().isConnected;

                if (isConnectedNow) {
                    // Background refresh — must never block routing.
                    void userStore.fetchUserPersona(userId, true);
                    void loginRevenueCat(userId).then((info) => {
                        if (info) useSubscriptionStore.getState().setCustomerInfo(info);
                    });

                    // No cached persona yet (fresh login) — downstream screens
                    // read it, so pull it before handing off. Routing no longer
                    // depends on it, so a failure here is simply swallowed.
                    if (!persona) {
                        try {
                            await userStore.fetchUserPersonaOrThrow(userId, true);
                        } catch {
                            // Non-fatal — the fact gate below is local.
                        }
                    }
                }

                // Onboarding is gated on LOCAL FACTS, never on the server's
                // onboardingStage. The stage flag lies — the wizard's Next
                // button writes FINISHED even when the persona chat captured
                // nothing — and it needs the network to be trusted. Facts are
                // what the app actually needs to build a feed, and counting
                // them is local, so this branch is offline-safe by
                // construction. Zero facts ALWAYS re-enters onboarding.
                let hasFacts = false;
                try {
                    hasFacts = await hasAnyFacts();
                } catch {
                    hasFacts = false;
                }

                if (cancelled) return;
                if (!hasFacts) {
                    router.replace('/logged-in/onboarding');
                } else {
                    router.replace('/logged-in/app_container/feed');
                }
            } catch {
                if (!cancelled) router.replace('/logged-in/app_container/feed');
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
