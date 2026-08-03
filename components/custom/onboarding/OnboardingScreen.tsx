import AbstractGradientBackdrop from '@/components/custom/AbstractGradientBackdrop';
import OnboardingWizard from "@/components/custom/onboarding/OnboardingWizard";
import { Box } from "@/components/ui/box";
import { Spinner } from "@/components/ui/spinner";
import { hasAnyFacts } from "@/lib/database/services/fact-service";
import { getSetting } from "@/lib/database/services/setting-service";
import { hasIdentityFault, resolveIdentity } from "@/lib/security/identity-gate";
import { clearPreviousUserData, useUserStore } from "@/lib/stores";
import { useNetworkStore } from "@/lib/stores/network-store";
import { useEffect, useState } from "react";

interface OnboardingScreenProps {
    userId: string;
    onLoginRedirect: () => void;
    onComplete: () => void;
}

/**
 * Onboarding gate for the post-login path (login / deep-link verify →
 * /logged-in/onboarding).
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
const OnboardingScreen: React.FC<OnboardingScreenProps> = ({ userId, onLoginRedirect, onComplete }) => {
    const [showOnboarding, setShowOnboarding] = useState(false);
    const [isCheckingOnboarding, setIsCheckingOnboarding] = useState(true);

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
                const verdict = resolveIdentity({
                    sessionUserId: userId,
                    cachedUserId,
                    ownershipFault: await hasIdentityFault(),
                    isConnected: useNetworkStore.getState().isConnected,
                });

                if (verdict === 'reauth') {
                    // Unresolvable locally. onLoginRedirect routes to
                    // /login?reauth=1 — the reauth param is load-bearing, see
                    // app/logged-in/onboarding.tsx.
                    if (!cancelled) onLoginRedirect();
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
                onComplete();
                return;
            }

            setShowOnboarding(true);
            setIsCheckingOnboarding(false);
        };

        checkOnboardingStatus();

        return () => {
            cancelled = true;
        };
    }, [userId, onComplete]);

    const handleOnboardingComplete = () => {
        setShowOnboarding(false);
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
        return <OnboardingWizard onComplete={handleOnboardingComplete} />;
    }

    return null;
};

export default OnboardingScreen;
