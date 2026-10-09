import AbstractGradientBackdrop from '@/components/custom/AbstractGradientBackdrop';
import OnboardingWizard from "@/components/custom/onboarding/OnboardingWizard";
import { Box } from "@/components/ui/box";
import { Spinner } from "@/components/ui/spinner";
import IdentitySwitchFailedScreen from "@/components/custom/auth/IdentitySwitchFailedScreen";
import { useOnboardingGate } from "@/components/custom/onboarding/useOnboardingGate";

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
    /** The ONE landing after onboarding (or for a user who already has facts):
     *  the route sends it to the Dashboard. There is no second, plan-dependent
     *  destination any more. */
    onComplete: () => void;
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
const OnboardingScreen: React.FC<OnboardingScreenProps> = ({ userId, sessionUserId, onLoginRedirect, onComplete }) => {
    const { showOnboarding, isCheckingOnboarding, wipeFailed, handleRetry, handleOnboardingComplete } =
        useOnboardingGate({ userId, sessionUserId, onLoginRedirect, onComplete });


    // Fail closed. Checked BEFORE the spinner: nothing was stamped and no
    // handler was called, so this component is still what the user is looking
    // at, and it must not be a spinner that never resolves.
    if (wipeFailed) {
        return <IdentitySwitchFailedScreen onRetry={handleRetry} />;
    }

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