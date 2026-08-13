import { Box } from "@/components/ui/box";
import MeraLogo from "@/components/custom/MeraLogo";
import IdentitySwitchFailedScreen from "@/components/custom/auth/IdentitySwitchFailedScreen";
import { authClient } from "@/lib/auth-client";
import logger from "@/lib/logger";
import { clearPreviousUserData } from "@/lib/stores";
import { hasAnyFacts } from "@/lib/database/services/fact-service";
import { getSetting } from "@/lib/database/services/setting-service";
import {
    clearPendingAuthUserId,
    effectiveSessionUserId,
    hasIdentityFault,
    readPendingAuthUserId,
    resolveIdentity,
} from "@/lib/security/identity-gate";
import { useUserStore } from "@/lib/stores/user-store";
import { probeServerReachable, useNetworkStore } from "@/lib/stores/network-store";
import { useSubscriptionStore } from "@/lib/stores/subscription-store";
import { loginRevenueCat } from "@/lib/revenuecat";
import { navigateToPaywall } from "@/lib/nav-state";
import { syncEntitlement } from "@/lib/subscription/entitlement-sync";
import { readFirstOpenDismissed } from "@/lib/subscription/first-open-dismissal";
import { readStartupTab } from "@/lib/navigation/startup-tab";
import {
    decideOnboardingEntry,
    resolveEntitlementForOnboarding,
} from "@/lib/subscription/onboarding-paywall";
import { router } from "expo-router";
import { useCallback, useEffect, useState } from "react";

export default function LoggedInIndex() {
    // useSession is a non-blocking enhancement — routing is driven by LOCAL
    // persona state so the app works offline and a dead session never bounces
    // the user out.
    const { data: session } = authClient.useSession();

    // Fail-closed state. `wipeFailed` renders the blocking screen INSTEAD of
    // routing; `retryNonce` is what its "Try again" bumps to re-run the effect.
    const [wipeFailed, setWipeFailed] = useState(false);
    const [retryNonce, setRetryNonce] = useState(0);

    const handleRetry = useCallback(() => {
        setWipeFailed(false);
        setRetryNonce((n) => n + 1);
    }, []);

    useEffect(() => {
        let cancelled = false;
        // Set the moment `cached_user_id` has been written for the user we
        // resolved. It is what narrows the catch at the bottom: a failure
        // BEFORE this point tells us nothing about who owns the data on this
        // device, so falling through to the feed there is the fail-OPEN shape
        // that let the leak reach the shell.
        let identityStamped = false;

        const determineRoute = async () => {
            // Identity is local-first: the persisted userId survives a dead
            // session. Fall back to a live session id if nothing is persisted yet.
            const localUserId = await getSetting('cached_user_id');

            // WHO AUTHENTICATED IN THIS PROCESS. The session atom outranks it
            // and it is only ever a hole-filler — but the hole is the bug: the
            // reauth path navigates here the instant OTP succeeds, before
            // better-auth's atom settles, so `session?.user?.id` is `undefined`
            // for a window in which this gate is being asked to decide.
            const pendingAuthUserId = readPendingAuthUserId();
            const effective = effectiveSessionUserId(session?.user?.id, pendingAuthUserId);
            const userId = effective ?? localUserId;

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
                //
                // Swallowed rather than left to the catch below: a throwing
                // probe is a connectivity failure, not an identity one, and
                // since the catch now fails CLOSED before the stamp it would
                // otherwise put a perfectly coherent user on the blocking
                // screen. `undefined` is the established "unprobed" value.
                let serverReachable: boolean | undefined;
                if (ownershipFault && isConnected) {
                    try {
                        serverReachable = await probeServerReachable();
                    } catch {
                        serverReachable = undefined;
                    }
                }

                const verdict = resolveIdentity({
                    // The LIVE atom, kept separate from `pendingAuthUserId` on
                    // purpose — resolveIdentity owns the precedence rule, and
                    // pre-coalescing here would hand it the same value twice
                    // and make the comparison compare a value against itself.
                    sessionUserId: session?.user?.id,
                    pendingAuthUserId,
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

                // `&& effective`, NOT `&& session?.user?.id`. That older guard
                // is the single easiest way to implement all of this and ship
                // nothing: after the recorder exists, `effective` can be a real
                // id while the session atom is still `undefined`, so keying on
                // the atom leaves the wipe unreachable on exactly the path the
                // leak travels — and every unit test still passes.
                //
                // The ARGUMENT matters as much as the guard: wiping with
                // `session.user.id` while `effective` came from the recorder
                // would pass `undefined`, and clearPreviousUserData's
                // `cachedUserId !== newUserId` test is true against `undefined`
                // — it would wipe, for the wrong reason, on the wrong input.
                if (verdict === 'wipeAndProceed' && effective) {
                    // BEFORE the destructive call, never inside it. A wipe
                    // already in flight must be allowed to complete: it is
                    // half-way through a sequence whose whole safety property
                    // is that it finishes or is finished on the next launch.
                    // This only stops a SUPERSEDED run from starting a second
                    // one and then stamping its stale owner over the live one.
                    if (cancelled) return;
                    try {
                        await clearPreviousUserData(effective);
                    } catch (error) {
                        // ── FAIL CLOSED ──────────────────────────────────
                        // The previous owner's facts, reading history, saved
                        // items, chat and topics are still on this device and
                        // the incoming user must not be routed into a shell
                        // that reads them. Do NOT stamp and do NOT route: the
                        // unchanged `cached_user_id` IS the retry marker, and
                        // it is what makes the next launch re-detect the
                        // mismatch. Same principle as purgeOrphanedLocalData.
                        logger.captureException(error, {
                            tags: { component: 'LoggedInIndex', method: 'clearPreviousUserData' },
                        });
                        if (!cancelled) setWipeFailed(true);
                        return;
                    }
                }

                if (cancelled) return;
                if (effective) {
                    // A PROVEN identity — persist it. This is the only writer
                    // of `cached_user_id` on this path.
                    userStore.setUserId(effective);
                    // Consumed. The stamp is the durable form of the same fact,
                    // so keeping the recording could only let a stale value mask
                    // a later switch.
                    clearPendingAuthUserId();
                } else {
                    // Offline / unresolved session: the only id we have is the
                    // one already on disk, so adopt it IN MEMORY and write
                    // nothing. Re-stamping it is what made a missed account
                    // switch sticky — the gate coalesced session ?? local and
                    // then wrote the result back, re-stamping the previous
                    // owner. For an offline user this is byte-for-byte the same
                    // state the old `setUserId(userId)` produced.
                    userStore.adoptLocalUserId(userId);
                }
                identityStamped = true;

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
                if (cancelled) return;
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
                    // The server's verdict, which outranks RevenueCat's mirror
                    // above. Forced: this is a fresh session, and the 60s
                    // debounce must not make a returning user wait a minute to
                    // learn their plan lapsed while the app was closed.
                    void syncEntitlement({ force: true });

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
                //
                // COUPLING, stated because it is invisible: `facts` has no user
                // column, so this count is device-GLOBAL. It is a safe gate if
                // and only if the wipe above is correct AND fails closed. The
                // day something routes past a failed wipe, this line reads the
                // PREVIOUS user's facts and reports the incoming user as
                // already onboarded. That is the leak, and this is the line it
                // comes out of.
                let hasFacts = false;
                try {
                    hasFacts = await hasAnyFacts();
                } catch {
                    hasFacts = false;
                }

                if (cancelled) return;
                if (hasFacts) {
                    // Still pays for none of the entitlement wait below — the
                    // startup-tab lookup is a plain local settings read, not a
                    // network round trip. Reads the setting directly rather
                    // than the Zustand store: hydrateAllStores() is
                    // fire-and-forget, so the store may not be hydrated yet
                    // (see lib/navigation/startup-tab.ts).
                    const startupTab = await readStartupTab();
                    if (cancelled) return;
                    router.replace(`/logged-in/app_container/${startupTab}`);
                    return;
                }

                // ── PAYWALL BEFORE ONBOARDING ────────────────────────────
                //
                // Zero facts ⇒ the wizard is next, and the wizard's step 2 is a
                // Mera chat that cannot work without an entitlement (see
                // lib/subscription/onboarding-paywall.ts). Resolve billing
                // BEFORE the redirect so a user with no plan meets the paywall
                // rather than a 401.
                //
                // The same decision is enforced again in OnboardingScreen,
                // which is the actual chokepoint — DeepLinkVerifyScreen
                // redirects straight to /logged-in/onboarding and never reaches
                // this file. (app/login.tsx used to do the same; since
                // 2026-08-06 it redirects here instead.) This copy exists so the
                // cold-start path resolves in place instead of bouncing through
                // that route. Both call the same two functions; the logic has
                // one home.
                const aiAccess = await resolveEntitlementForOnboarding({
                    userId,
                    isConnected: useNetworkStore.getState().isConnected,
                });
                if (cancelled) return;

                // `!== 'entitled'`, not `=== 'locked'`. Since 2026-08-06
                // `'unknown'` (never-resolved device) diverts as well, and
                // hard-coding `false` for it would push a user who already
                // dismissed the paywall back into it on every launch. This
                // guard and OnboardingScreen's must stay identical.
                const firstOpenDismissed =
                    aiAccess !== 'entitled' ? await readFirstOpenDismissed() : false;
                if (cancelled) return;

                switch (decideOnboardingEntry({ aiAccess, firstOpenDismissed })) {
                    case 'paywall':
                        navigateToPaywall();
                        return;
                    case 'free-tier':
                        router.replace('/logged-in/app_container/feed');
                        return;
                    default:
                        router.replace('/logged-in/onboarding');
                        return;
                }
            } catch (error) {
                // NARROWED. This used to drop every failure into the feed,
                // which is fail-OPEN for anything that went wrong before we
                // knew who owns this device: the shell then reads whatever
                // facts and persona are lying around. Route onward only for
                // failures that provably happened AFTER identity was resolved
                // and stamped — hydration, a persona fetch, the fact count, the
                // entitlement resolve. Those are all recoverable and all
                // already about the right user.
                logger.captureException(error, {
                    tags: { component: 'LoggedInIndex', method: 'determineRoute' },
                    extra: { identityStamped },
                });
                if (cancelled) return;
                if (identityStamped) router.replace('/logged-in/app_container/feed');
                else setWipeFailed(true);
            }
        };

        determineRoute();

        return () => {
            cancelled = true;
        };
        // Re-run when the session id changes (login/logout), and when the
        // blocking screen asks for a retry. Never on a useSession poll tick.
    }, [session?.user?.id, retryNonce]);

    // Fail closed. Nothing was stamped and nothing was routed, so this screen
    // is still mounted and is the only thing the user can see. It reads no
    // store and no persona — see its header for why that is a correctness rule
    // rather than a preference.
    if (wipeFailed) {
        return <IdentitySwitchFailedScreen onRetry={handleRetry} />;
    }

    // Spinner while (and after) routing — the replace() unmounts this screen.
    return (
        <Box className="flex-1 justify-center items-center bg-black">
            <MeraLogo size={96} animated />
        </Box>
    );
}
