// Whether Mera's cloud reading is held right now (the daily reading is used
// up), for every surface that changes with it: the counts card's limited
// state, the not-read line and the note-writing state.
//
// `isReadHeld` is a pure time check and the hold's end emits nothing, so
// while a hold is set this re-checks every minute and when the app comes
// back. On-device reading is never held.
//
// One call per SURFACE, never per card: the Feed reads it once in its list
// (useFeedScreen) and passes the result down to its rows.

import { ProcessingMode } from '@/lib/generated/graphql-types';
import { isReadHeld, useReadHold } from '@/lib/subscription/read-hold';
import { useEffect, useReducer } from 'react';
import { AppState } from 'react-native';

const HOLD_RECHECK_MS = 60_000;

export interface ReadHeld {
    readonly held: boolean;
    /** The server's reset instant while held, else null. */
    readonly resetAt: number | null;
}

/** Required at call time: the store reaches the settings table at module
 *  scope, and the detail container sits in the card graph (initializeJSI). */
function protocolStore(): typeof import('@/lib/stores/mera-protocol-store') {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require('@/lib/stores/mera-protocol-store');
}

export function useReadHeld(): ReadHeld {
    const { useProcessingMode } = protocolStore();
    const processingMode = useProcessingMode();
    const hold = useReadHold();
    const [, recheck] = useReducer((n: number) => n + 1, 0);
    const holding = hold.resetAt != null;
    useEffect(() => {
        if (!holding) return;
        const timer = setInterval(recheck, HOLD_RECHECK_MS);
        const sub = AppState.addEventListener('change', (s) => {
            if (s === 'active') recheck();
        });
        return () => {
            clearInterval(timer);
            sub.remove();
        };
    }, [holding]);
    const held = processingMode !== ProcessingMode.OnDevice && holding && isReadHeld(Date.now());
    return { held, resetAt: held ? hold.resetAt : null };
}
