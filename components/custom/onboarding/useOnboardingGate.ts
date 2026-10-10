import { isOnboardingDone } from "@/components/custom/onboarding/onboarding-done";
import { wipeOnce } from "@/components/custom/auth/useLoggedInGate";
import { getSetting, setSetting } from "@/lib/database/services/setting-service";
import logger from "@/lib/logger";
import {
    clearPendingAuthUserId,
    effectiveSessionUserId,
    hasIdentityFault,
    readPendingAuthUserId,
    resolveIdentity,
} from "@/lib/security/identity-gate";
import { useUserStore } from "@/lib/stores";
import { probeServerReachable, useNetworkStore } from "@/lib/stores/network-store";
import { startEntitlementWarmup } from "@/lib/subscription/onboarding-paywall";
import { useCallback, useEffect, useRef, useState } from "react";

export function useOnboardingGate({ userId, sessionUserId, onLoginRedirect, onComplete }: {
    userId: string;
    sessionUserId?: string;
    onLoginRedirect: () => void;
    onComplete: () => void;
}) {
    const [showOnboarding, setShowOnboarding] = useState(false);
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
    const handlersRef = useRef({ onLoginRedirect, onComplete });
    useEffect(() => {
        handlersRef.current = { onLoginRedirect, onComplete };
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

                const effective = effectiveSessionUserId(sessionUserId, pendingAuthUserId);

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
                        // The launch gate's single-flight wipe: overlapping runs
                        // (the session atom settling mid-wipe) share ONE reset.
                        // resolveIdentity only answers this with an effective id.
                        if (!effective) throw new Error('wipe without a proven identity');
                        await wipeOnce(effective);
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
                // Stamp the new owner, and wait until it is on disk.
                // `cached_user_id` is the ONLY sentinel the shared wipe
                // (wipeOnce) keys off, and nothing else on the fresh-login path writes it
                // (app/logged-in/index.tsx, which this path bypasses, does).
                // Without it the wipe above is permanently a no-op for a user
                // who logged in but never cold-started, so the next user on the
                // device would inherit their facts and skip onboarding. A stamp
                // that did not land throws into the catch below (fail closed).
                // Order matters: wipe first (it may reset the whole DB), stamp
                // after. Same prologue as app/logged-in/index.tsx.
                if (effective) {
                    await setSetting('cached_user_id', effective);
                    if ((await getSetting('cached_user_id')) !== effective) throw new Error('stamp did not land');
                    useUserStore.getState().adoptLocalUserId(effective);
                } else {
                    // Offline / unresolved: the only id is the one already on
                    // disk, so adopt it in memory and write nothing.
                    useUserStore.getState().adoptLocalUserId(userId);
                }

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
                // FAIL CLOSED. Anything that throws before the stamp lands (a
                // settings read, the probe, the wipe, the stamp itself) tells
                // us nothing about who owns this device, and the
                // `onboarding_done` read below is device-global: falling
                // through to it would complete onboarding for somebody who
                // never did it. The unchanged `cached_user_id` is the retry
                // marker; Try again re-runs this.
                logger.captureException(error, {
                    tags: { component: 'OnboardingScreen', method: 'resolveIdentity' },
                });
                if (!cancelled) setWipeFailed(true);
                return;
            }

            // COUPLING, stated because it is invisible: the `onboarding_done`
            // row and the facts its migration counts are device-GLOBAL. A safe
            // gate if and only if the wipe above is correct AND fails closed.
            let done = false;
            try {
                done = await isOnboardingDone();
            } catch {
                // Can't read the local DB → not done (onboarding is
                // recoverable; a persona-less feed is not).
                done = false;
            }

            if (cancelled) return;

            if (done) {
                // Leave the spinner mounted: onComplete() replaces this route,
                // so rendering `null` here would only flash a blank screen.
                handlersRef.current.onComplete();
                return;
            }

            // ── WARM ENTITLEMENT, DO NOT WAIT ON IT ──────────────────────
            //
            // This used to hold the splash for up to 8 seconds resolving a
            // verdict, then send a user with no plan away from the wizard,
            // because step 2's Mera chat was refused a token without a
            // subscription. Starter is granted to every account now, so every
            // outcome of that wait led here anyway. A wait whose branches have
            // converged is pure latency, and it was charged to the slowest
            // launch there is: a brand-new user's first.
            //
            // The calls still FIRE. `loginRevenueCat` is not optional: without
            // it a later purchase attaches to the anonymous RevenueCat id and
            // the entitlement lands on nobody.
            startEntitlementWarmup(userId);

            // NO RESTORE OFFER HERE. Email sign-ins with zero local facts used
            // to get `BackupRecoveryFlow` as a pre-wizard step, on the theory
            // that zero facts is exactly the state a returning user is in on a
            // new phone. In practice "Enter your recovery code" was the first
            // thing most people saw and most people did not know what it meant.
            //
            // Restoring is now something a user goes and asks for: Settings >
            // "Backup and restore" opens Manage data, whose backup section
            // holds the restore action (`manage-data?restore=1` deep-links
            // straight to the code step). Doing it after the wizard is safe:
            // `lib/backup/allowlist.ts` forbids the identity settings from ever
            // entering a backup, so the post-restore reload lands on the
            // receiving device's own stamp with facts present.
            setShowOnboarding(true);
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

    return { showOnboarding, isCheckingOnboarding, wipeFailed, handleRetry, handleOnboardingComplete };
}
