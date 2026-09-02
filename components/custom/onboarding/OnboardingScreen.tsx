import AbstractGradientBackdrop from '@/components/custom/AbstractGradientBackdrop';
import OnboardingWizard from "@/components/custom/onboarding/OnboardingWizard";
import BackupRecoveryFlow from "@/components/custom/backup/BackupRecoveryFlow";
import { Box } from "@/components/ui/box";
import { Spinner } from "@/components/ui/spinner";
import { hasAnyFacts } from "@/lib/database/services/fact-service";
import { getSetting } from "@/lib/database/services/setting-service";
import IdentitySwitchFailedScreen from "@/components/custom/auth/IdentitySwitchFailedScreen";
import logger from "@/lib/logger";
import {
    clearPendingAuthUserId,
    hasIdentityFault,
    readPendingAuthUserId,
    resolveIdentity,
} from "@/lib/security/identity-gate";
import { clearPreviousUserData, useUserStore } from "@/lib/stores";
import { probeServerReachable, useNetworkStore } from "@/lib/stores/network-store";
import {
    decideOnboardingEntry,
    resolveEntitlementForOnboarding,
} from "@/lib/subscription/onboarding-paywall";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

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
     * No active plan → Mera News Free with onboarding skipped (the standalone
     * paywall screen was removed 2026-08-19; FreeTierCard on the feed carries
     * its pitch and actions). Deliberately NOT `onComplete`: that one carries
     * `fromOnboarding: "1"` and lands on the Dashboard, which is a claim about
     * a wizard that never ran. Mera News Free's established destination is the
     * feed.
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
const OnboardingScreen: React.FC<OnboardingScreenProps> = ({ userId, sessionUserId, onLoginRedirect, onComplete, onFreeTierMode }) => {
    const { t } = useTranslation();
    const [showOnboarding, setShowOnboarding] = useState(false);
    const [showRestoreOffer, setShowRestoreOffer] = useState(false);
    const [isCheckingOnboarding, setIsCheckingOnboarding] = useState(true);
    // Fail-closed state, mirroring app/logged-in/index.tsx rather than
    // inventing a second shape. This screen needs its own copy because
    // DeepLinkVerifyScreen lands here directly and never passes through that
    // file — a wipe that throws on THIS doorway would otherwise fall through to
    // the fact count, read the previous owner's facts, and complete.
    const [wipeFailed, setWipeFailed] = useState(false);
    const [retryNonce, setRetryNonce] = useState(0);

    const handleRetry = useCallback(() => {
        setWipeFailed(false);
        setRetryNonce((n) => n + 1);
    }, []);

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
    const handlersRef = useRef({ onLoginRedirect, onComplete, onFreeTierMode });
    useEffect(() => {
        handlersRef.current = { onLoginRedirect, onComplete, onFreeTierMode };
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

                // Who authenticated in this process. The caller has already
                // folded this into `userId` (see app/logged-in/onboarding.tsx),
                // which is what makes the wipe target and the stamp correct —
                // but resolveIdentity still needs it RAW, because it owns the
                // precedence rule and `userId` cannot tell it whether the id it
                // holds was proven or merely read off this device's disk.
                const pendingAuthUserId = readPendingAuthUserId();

                const verdict = resolveIdentity({
                    // The LIVE session id, never the coalesced `userId` — see
                    // the prop doc. Passing `userId` here would make this
                    // comparison compare the local id against itself.
                    sessionUserId,
                    pendingAuthUserId,
                    cachedUserId,
                    ownershipFault,
                    isConnected,
                    serverReachable,
                });

                if (verdict === 'reauth') {
                    // Unresolvable locally. onLoginRedirect routes to
                    // /login?reauth=1, where AuthScreen offers OTP or device
                    // sign-in (for accounts with no email) — the reauth param
                    // is load-bearing, see app/logged-in/onboarding.tsx.
                    if (!cancelled) handlersRef.current.onLoginRedirect();
                    return;
                }

                if (verdict === 'wipeAndProceed') {
                    // BEFORE the destructive call, never inside it: a wipe
                    // already in flight must be allowed to finish.
                    if (cancelled) return;
                    try {
                        await clearPreviousUserData(userId);
                    } catch (error) {
                        // ── FAIL CLOSED ──────────────────────────────────
                        // The previous owner's data is still here. Do NOT
                        // stamp and do NOT fall through to the fact count:
                        // that count is device-global, so it would report the
                        // incoming user as already onboarded and hand them the
                        // previous owner's feed. Leaving `cached_user_id`
                        // untouched is the retry marker for the next launch.
                        logger.captureException(error, {
                            tags: { component: 'OnboardingScreen', method: 'clearPreviousUserData' },
                        });
                        if (!cancelled) setWipeFailed(true);
                        return;
                    }
                }
                if (cancelled) return;
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

                // Consumed — but only when the value just written to disk IS
                // the recorded one. On the offline path `userId` came off the
                // disk instead, and dropping a recording that has not been
                // stamped anywhere would lose the only trace of who signed in.
                if (pendingAuthUserId && userId === pendingAuthUserId) {
                    clearPendingAuthUserId();
                }

                // Deferred fault — keep authenticated background work gated
                // until it is genuinely resolved. Must follow the wipe above,
                // which resets the user store. See app/logged-in/index.tsx for
                // the full rationale.
                if (ownershipFault) {
                    useUserStore.getState().setNeedsReauth(true);
                }
            } catch (error) {
                // NARROWED. This used to swallow a broken WIPE too, and falling
                // through to the count on a failed wipe is the leak: the count
                // is device-global, so it sees the previous owner's facts and
                // completes onboarding for somebody who never did it. The wipe
                // now has its own catch above and never reaches this one, which
                // is left to cover the surrounding READS — a getSetting on a
                // cold DB must still not strand the user on a spinner.
                logger.captureException(error, {
                    tags: { component: 'OnboardingScreen', method: 'resolveIdentity' },
                });
            }

            // COUPLING, stated because it is invisible: `facts` has no user
            // column, so this count is device-GLOBAL. It is a safe gate if and
            // only if the wipe above is correct AND fails closed. Anything that
            // routes past a failed wipe makes this line read the PREVIOUS
            // user's facts and report the incoming user as already onboarded.
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

            // `hasFacts` is provably false here (the early return above), but
            // it is passed rather than hardcoded so the D29 carve-out stays
            // correct if that guard ever moves.
            const entry = decideOnboardingEntry({ aiAccess, hasAnyFacts: hasFacts });
            if (entry !== 'onboarding') {
                // Leave the spinner mounted: the callback replaces this route,
                // so rendering anything else here would only flash.
                handlersRef.current.onFreeTierMode();
                return;
            }

            // ── OFFER A RESTORE BEFORE BUILDING A PERSONA FROM SCRATCH ───
            //
            // EMAIL SIGN-INS ONLY. `cached_user_email` is written by exactly
            // the email/OTP verify paths (OTPVerificationView,
            // DeepLinkVerifyScreen) plus checkout email-attach — which happens
            // after onboarding, so it cannot leak into this gate. A device
            // sign-in never writes it, and a device-minted account is by
            // definition brand new: it has no backup to bring back, so the
            // offer would only be a confusing extra screen between "Get
            // started" and the wizard. Anonymous reinstallers who DID keep a
            // recovery code still have the Settings > Manage data path.
            //
            // For email users the ask is worth one tap: zero local facts is
            // exactly the state a returning user is in on a new phone, and
            // declining costs a tap while accepting saves rebuilding months of
            // persona by hand.
            //
            // It does NOT need to skip the wizard itself: onboarding gates on
            // local facts, a restore writes facts, and the restore reloads the
            // app — so the next pass through this very check takes the
            // `hasFacts` branch above and calls onComplete(). One gate, not two.
            const emailSignIn = !!(await getSetting('cached_user_email'));
            if (cancelled) return;
            if (emailSignIn) {
                setShowRestoreOffer(true);
            } else {
                setShowOnboarding(true);
            }
            setIsCheckingOnboarding(false);
        };

        checkOnboardingStatus();

        return () => {
            cancelled = true;
        };
        // IDENTITY ONLY, plus the blocking screen's retry. `onComplete` used to
        // be here; see the ref above for what that cost. Re-running this gate
        // is only ever correct when the user it is about changes, or when the
        // user explicitly asks for the failed wipe to be tried again.
    }, [userId, sessionUserId, retryNonce]);

    const handleOnboardingComplete = () => {
        setShowOnboarding(false);
        // Not via the ref: this is an event handler, not the long-lived effect,
        // so the prop it closes over is by definition the current one.
        onComplete();
    };

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

    if (showRestoreOffer) {
        return (
            <Box className="flex-1 justify-center px-6">
                {/* Page background. Must be the FIRST child so it paints behind
                    everything else on the page. */}
                <AbstractGradientBackdrop />
                <BackupRecoveryFlow
                    introText={t('backup.onboardingIntro')}
                    skipLabel={t('backup.onboardingSkip')}
                    onSkip={() => {
                        setShowRestoreOffer(false);
                        setShowOnboarding(true);
                    }}
                    // Only if the reload failed. The data IS restored, so
                    // sending them into the wizard would have them rebuild a
                    // persona they already have.
                    onRestoredWithoutReload={() => handlersRef.current.onComplete()}
                />
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
