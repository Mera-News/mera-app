import AbstractGradientBackdrop from '@/components/custom/AbstractGradientBackdrop';
import OnboardingWizard from "@/components/custom/onboarding/OnboardingWizard";
import { Box } from "@/components/ui/box";
import { Spinner } from "@/components/ui/spinner";
import { hasAnyFacts } from "@/lib/database/services/fact-service";
import { getSetting } from "@/lib/database/services/setting-service";
import { hasIdentityFault, resolveIdentity } from "@/lib/security/identity-gate";
import { clearPreviousUserData, useUserStore } from "@/lib/stores";
import { probeServerReachable, useNetworkStore } from "@/lib/stores/network-store";
import { readFirstOpenDismissed } from "@/lib/subscription/first-open-dismissal";
import {
    decideOnboardingEntry,
    resolveEntitlementForOnboarding,
} from "@/lib/subscription/onboarding-paywall";
import { useEffect, useRef, useState } from "react";

interface OnboardingScreenProps {
    /**
     * EFFECTIVE owner of this device: the live session id when there is one,
     * else the persisted `cached_user_id`. Used for the wipe target and the
     * ownership stamp.
     */
    userId: string;
    /**
     * LIVE session id, `undefined` when offline or unresolved.
     *
     * Deliberately separate from `userId`, and load-bearing. The caller now
     * coalesces `session ?? local` into `userId` so this screen works offline —
     * if that coalesced value were also passed as `sessionUserId`, then
     * `sessionUserId === cachedUserId` would hold BY CONSTRUCTION and
     * resolveIdentity's mismatch check would silently become a permanent no-op,
     * disabling the fresh-login cross-user wipe this screen exists to perform.
     * An absent session is the OFFLINE path, which resolveIdentity already reads
     * as 'coherent'.
     */
    sessionUserId?: string;
    onLoginRedirect: () => void;
    onComplete: () => void;
    /**
     * No active plan and the first-open paywall has not been dismissed on this
     * device → present the paywall INSTEAD of the wizard. See
     * `lib/subscription/onboarding-paywall.ts` for why the order matters.
     */
    onPaywall: () => void;
    /**
     * No active plan, but the paywall was already dismissed → Mera News Free
     * with onboarding skipped. Deliberately NOT `onComplete`: that one carries
     * `fromOnboarding: "1"` and lands on the Dashboard, which is a claim about
     * a wizard that never ran. Mera News Free's established destination is the
     * feed — the same one `NotSubscribedScreen`'s "Continue without a plan"
     * uses.
     */
    onFreeTierMode: () => void;
}

/**
 * Onboarding gate for the /logged-in/onboarding route (reached from the
 * cold-start gate and from deep-link verify).
 *
 * The gate is LOCAL FACTS, not the server's `onboardingStage`. The stage flag
 * lies — the wizard's Next button advances it to FINISHED whether or not the
 * persona chat captured anything — so a user could arrive "onboarded" with an
 * empty persona and a permanently empty feed. Zero facts therefore ALWAYS
 * re-enters the wizard, even at stage FINISHED; that re-entry is intentional.
 * `advanceOnboardingStage` is still written by the wizard (step-resume +
 * server-side analytics), it just no longer decides anything here.
 *
 * Consequence: this gate needs no network at all. It works offline and a dead
 * server session can no longer bounce a user through onboarding.
 */
const OnboardingScreen: React.FC<OnboardingScreenProps> = ({ userId, sessionUserId, onLoginRedirect, onComplete, onPaywall, onFreeTierMode }) => {
    const [showOnboarding, setShowOnboarding] = useState(false);
    const [isCheckingOnboarding, setIsCheckingOnboarding] = useState(true);

    // ── WHY THE HANDLERS LIVE IN A REF ──────────────────────────────────────
    //
    // The gate below awaits `resolveEntitlementForOnboarding`, which holds for
    // up to ONBOARDING_ENTITLEMENT_WAIT_MS. Its dep array used to include
    // `onComplete`, and the parent (`app/logged-in/onboarding.tsx`) defines its
    // handlers as plain inline functions — a new identity on EVERY render. Each
    // re-render therefore tore the effect down, set `cancelled = true`, threw
    // away the in-flight wait and started it again from zero. The better-auth
    // session atom is documented to change at least twice on a cold start
    // (app/index.tsx), so on the path that matters the wait essentially never
    // completed and the gate decided on an unresolved verdict — the 2026-08-06
    // regression.
    //
    // A ref rather than only `useCallback` in the parent: the fix has to hold at
    // this chokepoint no matter which caller mounts the screen (there are two,
    // and DeepLinkVerifyScreen's is not the one that was audited). The parent
    // memoizes as well — cheap, and it stops needless re-renders — but this is
    // what makes the property true. Reading a ref inside the effect also keeps
    // `react-hooks/exhaustive-deps` satisfied WITHOUT a disable comment, which a
    // bare dep removal would not.
    //
    // Written in an effect, never during render (React Compiler is enabled).
    // `useRef`'s initializer already carries the mount-time identities, and this
    // effect is declared BEFORE the gate's so the refresh always lands first.
    const handlersRef = useRef({ onLoginRedirect, onComplete, onPaywall, onFreeTierMode });
    useEffect(() => {
        handlersRef.current = { onLoginRedirect, onComplete, onPaywall, onFreeTierMode };
    });

    useEffect(() => {
        let cancelled = false;

        const checkOnboardingStatus = async () => {
            // Identity coherence MUST be settled before the fact count. `facts`
            // is device-global (no user column), so cross-user isolation is a
            // full local wipe keyed off `cached_user_id`. The cold-start path
            // does this in app/logged-in/index.tsx, but the fresh-login redirect
            // lands here directly and bypasses it — without this, user B on user
            // A's device would inherit A's facts and skip onboarding entirely.
            try {
                // Read the on-disk owner BEFORE anything else — the wipe below
                // may delete it, so it cannot be read afterwards.
                const cachedUserId = await getSetting('cached_user_id');
                const ownershipFault = await hasIdentityFault();
                const isConnected = useNetworkStore.getState().isConnected;
                // Probe only on the (rare) fault path — see app/logged-in/index.tsx.
                const serverReachable =
                    ownershipFault && isConnected ? await probeServerReachable() : undefined;

                const verdict = resolveIdentity({
                    // The LIVE session id, never the coalesced `userId` — see
                    // the prop doc. Passing `userId` here would make this
                    // comparison compare the local id against itself.
                    sessionUserId,
                    cachedUserId,
                    ownershipFault,
                    isConnected,
                    serverReachable,
                });

                if (verdict === 'reauth') {
                    // Unresolvable locally. onLoginRedirect routes to
                    // /login?reauth=1 — the reauth param is load-bearing, see
                    // app/logged-in/onboarding.tsx.
                    if (!cancelled) handlersRef.current.onLoginRedirect();
                    return;
                }

                if (verdict === 'wipeAndProceed') {
                    await clearPreviousUserData(userId);
                }
                // Stamp the new owner. `cached_user_id` is the ONLY sentinel
                // clearPreviousUserData keys off, and until now nothing on the
                // fresh-login path wrote it (setUserId lives in
                // app/logged-in/index.tsx, which this path bypasses). Without
                // this the wipe above is permanently a no-op for a user who
                // logged in but never cold-started, so the next user on the
                // device would inherit their facts and skip onboarding.
                // Order matters: wipe first (it may reset the whole DB), stamp
                // after. Same prologue as app/logged-in/index.tsx.
                useUserStore.getState().setUserId(userId);

                // Deferred fault — keep authenticated background work gated
                // until it is genuinely resolved. Must follow the wipe above,
                // which resets the user store. See app/logged-in/index.tsx for
                // the full rationale.
                if (ownershipFault) {
                    useUserStore.getState().setNeedsReauth(true);
                }
            } catch {
                // A broken wipe must not strand the user on a spinner — fall
                // through to the count and let it decide.
            }

            let hasFacts = false;
            try {
                hasFacts = await hasAnyFacts();
            } catch {
                // Can't read the local DB → treat as no facts (onboarding is
                // recoverable; a persona-less feed is not).
                hasFacts = false;
            }

            if (cancelled) return;

            if (hasFacts) {
                // Leave the spinner mounted: onComplete() replaces this route,
                // so rendering `null` here would only flash a blank screen.
                handlersRef.current.onComplete();
                return;
            }

            // ── PAYWALL BEFORE ONBOARDING ────────────────────────────────
            //
            // This is the ordering fix, and it lives HERE rather than in
            // app/logged-in/index.tsx because this component is the only
            // mounter of OnboardingWizard: DeepLinkVerifyScreen redirects
            // straight to /logged-in/onboarding and never touches the
            // cold-start gate, so a check placed only there would be bypassed
            // by that doorway.
            //
            // 2026-08-06: app/login.tsx was a second such doorway and is no
            // longer one — it now redirects to /logged-in, which resolves
            // identity, local facts and entitlement like every other entry.
            //
            // Reached only with ZERO local facts, so an already-onboarded user
            // never pays for any of it. `isCheckingOnboarding` stays true for
            // the whole await, which is what keeps the existing spinner up
            // instead of flashing the wizard at someone who is about to be sent
            // to the paywall.
            const aiAccess = await resolveEntitlementForOnboarding({
                userId,
                // Re-read rather than reusing the value from the identity gate
                // above: several awaits have happened since.
                isConnected: useNetworkStore.getState().isConnected,
            });
            if (cancelled) return;

            // Only consulted when it can change the outcome — no DB read on the
            // subscriber path. `!== 'entitled'` rather than `=== 'locked'`:
            // since 2026-08-06 `'unknown'` diverts too, and hard-coding `false`
            // there would send a user who already dismissed the paywall straight
            // back to it, forever.
            const firstOpenDismissed =
                aiAccess !== 'entitled' ? await readFirstOpenDismissed() : false;
            if (cancelled) return;

            const entry = decideOnboardingEntry({ aiAccess, firstOpenDismissed });
            if (entry !== 'onboarding') {
                // Leave the spinner mounted: both callbacks replace this route,
                // so rendering anything else here would only flash.
                if (entry === 'paywall') handlersRef.current.onPaywall();
                else handlersRef.current.onFreeTierMode();
                return;
            }

            setShowOnboarding(true);
            setIsCheckingOnboarding(false);
        };

        checkOnboardingStatus();

        return () => {
            cancelled = true;
        };
        // IDENTITY ONLY. `onComplete` used to be here; see the ref above for
        // what that cost. Re-running this gate is only ever correct when the
        // user it is about changes.
    }, [userId, sessionUserId]);

    const handleOnboardingComplete = () => {
        setShowOnboarding(false);
        // Not via the ref: this is an event handler, not the long-lived effect,
        // so the prop it closes over is by definition the current one.
        onComplete();
    };

    if (isCheckingOnboarding) {
        return (
            // No opaque fill: the AbstractGradientBackdrop below is the page background.
            <Box className="flex-1 justify-center items-center">
                {/* Page background. Must be the FIRST child so it paints behind
                    everything else on the page. */}
                <AbstractGradientBackdrop />

                <Spinner size="large" />
            </Box>
        );
    }

    if (showOnboarding) {
        // userId is threaded in so the wizard has an owner WITHOUT a round-trip.
        // It used to derive one solely from authClient.getSession(), which
        // yields nothing offline — leaving the persona step with an undefined
        // userId.
        return <OnboardingWizard userId={userId} onComplete={handleOnboardingComplete} />;
    }

    return null;
};

export default OnboardingScreen;
