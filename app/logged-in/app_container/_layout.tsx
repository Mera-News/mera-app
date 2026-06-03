import { Slot } from 'expo-router';
import { useEffect } from 'react';
import { AppState, View } from 'react-native';

import ErrorBoundary from '@/components/custom/ErrorBoundary';
import { FullScreenErrorFallback } from '@/components/custom/ErrorFallback';
import ModelDownloadBanner from '@/components/custom/ModelDownloadBanner';
import { recoverCycle } from '@/lib/services/cycle-state-machine';
import { runSync } from '@/lib/services/SuggestionSyncService';
import { useUserStore } from '@/lib/stores/user-store';
import logger from '@/lib/logger';

// Foreground polling cadence for the cycle state machine. Every tick we ask
// the SM "advance whatever state you're in by one step":
//   - idle → if new server-side suggestions exist, kick off submitting-relevance
//   - waiting-for-relevance / waiting-for-reason → poll /results
//   - submitting-* / unpacking-* → resume (idempotent; covers crash windows)
// Single-flight guards inside the reconciler and syncFeed collapse re-entries,
// so an interval that races a push wake or an AppState→active fire is safe.
//
// 30s strikes a balance: tight enough that a cycle started right after the
// hourly notification feels live to the user, loose enough that idle periods
// don't pound the gateway. Push wakes still drive the same flow when they
// arrive — the poll is a backstop, not the primary trigger.
const POLL_INTERVAL_MS = 30_000;

export default function AppLayout() {
    // Foreground entry point — fires once on mount, on every AppState→active,
    // AND on a 30s interval while the app is foregrounded. The mount fire
    // covers cold-start reopens (AppState is already 'active' when this
    // effect mounts so the change listener never sees a transition). The
    // change listener covers background→foreground. The interval keeps the
    // state machine ticking forward whatever state we're in — idle stays
    // idle until there's data to advance.
    useEffect(() => {
        const runOnce = async () => {
            // Drive any half-finished cycle one step forward. recoverCycle
            // returns the post-recovery state; only `idle` means we may
            // start fresh by submitting a new cycle via syncFeed. Anything
            // else (e.g. waiting-for-reason) means the cycle is still in
            // flight — the next poll tick or push wake will advance it.
            let state: Awaited<ReturnType<typeof recoverCycle>> = 'idle';
            try {
                state = await recoverCycle();
            } catch (err) {
                logger.captureException(err, {
                    tags: { service: 'AppLayout', method: 'recoverCycle' },
                });
            }
            if (state !== 'idle') return;

            const personaId = useUserStore.getState().userPersona?._id;
            if (!personaId) return;
            try {
                await runSync(personaId);
            } catch (err) {
                logger.captureException(err, {
                    tags: { service: 'AppLayout', method: 'foregroundSync' },
                });
            }
        };

        runOnce();

        const sub = AppState.addEventListener('change', (state) => {
            if (state !== 'active') return;
            runOnce();
        });

        // Foreground poll loop. Gates on AppState — the timer keeps firing
        // while backgrounded (RN doesn't suspend setInterval) but we skip
        // the work to avoid useless network traffic from a non-visible app.
        const interval = setInterval(() => {
            if (AppState.currentState !== 'active') return;
            runOnce();
        }, POLL_INTERVAL_MS);

        return () => {
            sub.remove();
            clearInterval(interval);
        };
    }, []);

    return (
        <View style={{ flex: 1 }}>
            <ErrorBoundary
                level="screen"
                FallbackComponent={FullScreenErrorFallback}
            >
                <Slot />
            </ErrorBoundary>
            <ModelDownloadBanner />
        </View>
    );
}
