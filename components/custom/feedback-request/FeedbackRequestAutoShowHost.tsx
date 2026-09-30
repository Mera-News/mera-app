// FeedbackRequestAutoShowHost: pops a live feedback request up ONCE per
// request, on its own, for every reader (a push reaches only readers with
// notifications on). Renders nothing. Mounted once in app/logged-in/_layout.tsx.
//
// LEVEL-TRIGGERED. It re-derives "is there anything to show" from the device
// state row on mount, on every state write (the sync task's upsert), on every
// return to the foreground and on every route change. The sync can run before
// this layout mounts (the boot's faked foreground), so a one-shot signal would
// reach nobody.
//
// ONCE. shownAt is stamped BEFORE navigating, and the modal stamps it again on
// mount for the push and drawer paths, so nothing presents a request twice.
//
// NEVER OVER SOMETHING ELSE. It waits while the PIN lock is up, before the
// startup gate has passed, on the onboarding, verify-otp and PIN routes and
// the modal itself, while the bug-report modal or the floating chat is open,
// and while ConsentGate is showing. Each check runs after a settle delay, so a
// notification tap the startup gate is about to open (the same modal) lands
// first and this defers to it. A deferred show simply retries on the next
// trigger.
//
// KNOWN GAP: EmailCaptureHost and WhatsNewSheet keep their visibility in
// component state with no exported read, so this host cannot see them.

import { router, usePathname } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';

import {
    needsConsent,
    fetchLegalVersions,
    wasLegalAcceptedThisProcess,
    type ConsentSessionUser,
} from '@/components/custom/auth/legal-consent';
import { authClient } from '@/lib/auth-client';
import {
    markFeedbackRequestShown,
    pickAutoShowCandidate,
    readFeedbackRequestsState,
    subscribeFeedbackRequestsState,
} from '@/lib/feedback-requests/feedback-request-state';
import logger from '@/lib/logger';
import { useFeedbackStore } from '@/lib/stores/feedback-store';
import { useFloatingChatStore } from '@/lib/stores/floating-chat-store';
import { isStartupGatePassed } from '@/lib/stores/pending-notification-route';
import { usePinStore } from '@/lib/stores/pin-store';

/** Long enough for the startup gate to open a stashed notification route and
 *  for a just-mounted screen's own sheet to decide; short enough to feel like
 *  part of arriving. */
const SETTLE_MS = 1500;

const BLOCKED_ROUTE_PARTS = ['/onboarding', 'verify-otp', 'pin-lock', 'pin-setup', '/feedback-request'];

function routeBlocks(pathname: string | null | undefined): boolean {
    if (!pathname) return true;
    // The logged-in index is the startup gate itself, never a place to land.
    if (pathname === '/logged-in' || pathname === '/logged-in/') return true;
    return BLOCKED_ROUTE_PARTS.some((part) => pathname.includes(part));
}

/** Synchronous gates, read fresh from the stores at the moment of showing. */
function storesBlock(): boolean {
    if (!isStartupGatePassed()) return true;
    if (usePinStore.getState().locked) return true;
    if (useFeedbackStore.getState().visible) return true;
    if (useFloatingChatStore.getState().isExpanded) return true;
    return false;
}

export default function FeedbackRequestAutoShowHost() {
    const pathname = usePathname();
    const pathnameRef = useRef(pathname);
    pathnameRef.current = pathname;
    const { data: session, isPending } = authClient.useSession();
    const userId = session?.user?.id ?? null;
    const sessionUserRef = useRef<ConsentSessionUser | undefined>(undefined);
    sessionUserRef.current = session?.user as ConsentSessionUser | undefined;
    const pinLocked = usePinStore((s) => s.locked);
    const feedbackVisible = useFeedbackStore((s) => s.visible);
    const chatOpen = useFloatingChatStore((s) => s.isExpanded);

    const [tick, setTick] = useState(0);
    const inFlight = useRef(false);
    /** ConsentGate's own answer, per user. Only a "no consent needed" answer
     *  is kept: a needed one is re-checked, and a failed fetch is not cached. */
    const consentClearFor = useRef<string | null>(null);

    useEffect(() => subscribeFeedbackRequestsState(() => setTick((n) => n + 1)), []);
    useEffect(() => {
        const sub = AppState.addEventListener('change', (next) => {
            if (next === 'active') setTick((n) => n + 1);
        });
        return () => sub.remove();
    }, []);

    useEffect(() => {
        if (isPending || !userId || pinLocked || feedbackVisible || chatOpen) return;
        if (routeBlocks(pathname)) return;

        const timer = setTimeout(() => {
            if (inFlight.current) return;
            inFlight.current = true;
            void (async () => {
                try {
                    const state = await readFeedbackRequestsState();
                    const id = pickAutoShowCandidate(state);
                    if (!id) return;
                    if (await consentShowing(userId)) return;
                    // Everything may have moved during the awaits: re-check.
                    if (storesBlock() || routeBlocks(pathnameRef.current)) return;
                    // Stamp FIRST: once stamped, navigate unconditionally, so
                    // "shown" never means "stamped but never presented".
                    if (!(await markFeedbackRequestShown(id))) return;
                    router.push({ pathname: '/logged-in/feedback-request', params: { id } });
                } catch (err) {
                    logger.captureException(err, {
                        tags: { component: 'FeedbackRequestAutoShowHost', method: 'show' },
                    });
                } finally {
                    inFlight.current = false;
                }
            })();
        }, SETTLE_MS);
        return () => clearTimeout(timer);

        // ConsentGate shows when the session user's accepted versions are
        // missing or stale, unless this process already recorded acceptance.
        // Same predicate, same exported helpers; fails open like the gate.
        async function consentShowing(uid: string): Promise<boolean> {
            if (wasLegalAcceptedThisProcess(uid)) return false;
            if (consentClearFor.current === uid) return false;
            const versions = await fetchLegalVersions();
            if (!versions) return false;
            if (needsConsent(sessionUserRef.current, versions)) return true;
            consentClearFor.current = uid;
            return false;
        }
    }, [tick, pathname, isPending, userId, pinLocked, feedbackVisible, chatOpen]);

    return null;
}
