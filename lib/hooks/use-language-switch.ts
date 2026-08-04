import { useCallback, useEffect, useRef, useState } from 'react';
import { BackHandler, Platform } from 'react-native';

import { useAppLanguageStore } from '@/lib/stores/app-language-store';
import {
    probeTranslationLanguage,
    TranslationProbeOutcome,
} from '@/lib/translation-service';
import logger from '@/lib/logger';

/**
 * The language-switch state machine, shared by both pickers.
 *
 * WHY A SHARED HOOK AND NOT TWO COPIES. This is a five-state machine with a
 * cancellation token, a modal-dismissal handshake, a navigation lock and a
 * revert path — and the pre-auth picker
 * (`components/custom/auth/LanguageSelector.tsx`) had a copy of the *previous*
 * version of this logic that was one line different from the Settings one.
 * That line was the whole bug: both fired a native translation call while an
 * RN `<Modal presentationStyle="pageSheet">` was still animating away. Two
 * copies of this cannot be allowed to drift again.
 *
 * THE SEQUENCE, AND WHY IT IS THIS SEQUENCE:
 *
 *  1. `requestSwitch(code)` — remembers the code. The screen closes its picker
 *     modal. NOTHING native happens yet.
 *  2. `notifyPickerDismissed()` — the screen calls this from the modal's
 *     `onDismiss`, i.e. once UIKit says the dismissal transition has actually
 *     finished. Only now do we probe.
 *
 *     This handshake is the fix for a hard native crash: the probe presents
 *     Apple's system download sheet from inside the native call, and presenting
 *     it while a view controller is mid-dismissal crashed the app on every
 *     language switch (reported on device, no JS logs — it is a native fault).
 *     Never collapse steps 1 and 2 into one, and never replace `onDismiss`
 *     with a `setTimeout` guess.
 *
 *  3. The probe runs. The screen shows a spinner, copy asking the user to
 *     stay put while the pack downloads, and a cancel button.
 *  4. Success → commit. Anything else → the user stays on the language they
 *     were already using. Nothing was applied, so there is nothing to undo.
 *
 * The user is NUDGED to wait, never trapped: `cancel()` is live from the
 * moment the spinner renders and does not wait on the native promise, because
 * that promise is exactly the thing that may hang.
 */

export type LanguageSwitchPhase =
    | 'idle'
    /** Code chosen; waiting for the picker modal to finish dismissing. */
    | 'awaiting-dismiss'
    /** Native probe in flight. */
    | 'probing';

export interface LanguageSwitchResult {
    readonly code: string;
    readonly outcome: TranslationProbeOutcome;
    /**
     * True when the attempt ended by applying ENGLISH rather than either the
     * requested language or the previous one — the `device-unsupported` case.
     * See the note at that branch in `runProbe` for why English and not the
     * previous language.
     */
    readonly fellBackToEnglish: boolean;
}

/**
 * Safety net for step 2. RN's `Modal.onDismiss` is iOS-only and, in practice,
 * reliable — but a phase that only a callback can leave is a trap if that
 * callback ever fails to fire, and `busy` disables the back button. So the
 * handshake self-heals.
 */
const DISMISS_HANDSHAKE_FALLBACK_MS = 1200;

interface UseLanguageSwitchOptions {
    /** Fired after the new language has been applied. */
    readonly onCommitted?: (code: string, previousCode: string) => void;
    /** Fired once the attempt ends in anything other than a plain commit. */
    readonly onResult?: (result: LanguageSwitchResult) => void;
}

export function useLanguageSwitch(options: UseLanguageSwitchOptions = {}) {
    const appLanguage = useAppLanguageStore((s) => s.appLanguage);
    const setAppLanguage = useAppLanguageStore((s) => s.setAppLanguage);

    const [phase, setPhase] = useState<LanguageSwitchPhase>('idle');
    const [pendingCode, setPendingCode] = useState<string | null>(null);

    // Bumped on every start and every exit. A probe that resolves after its
    // generation has moved on is orphaned: it may still have marked the
    // language verified inside the service (which is true and useful), but it
    // must not commit a language the user has already backed out of, nor
    // re-disable navigation on a screen they have left.
    const generationRef = useRef(0);
    const fallbackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    // Mirrors `phase` for synchronous reads. The transitions below fire a
    // native call, which must never live inside a `setState` updater — React
    // may invoke an updater more than once, and this one must run exactly
    // once (twice would be two concurrent sheets, the original bug).
    const phaseRef = useRef<LanguageSwitchPhase>('idle');

    // Latest callbacks, so the probe effect never depends on an unstable
    // inline identity.
    const optionsRef = useRef(options);
    optionsRef.current = options;

    const busy = phase !== 'idle';

    const clearFallbackTimer = useCallback(() => {
        if (fallbackTimerRef.current) {
            clearTimeout(fallbackTimerRef.current);
            fallbackTimerRef.current = null;
        }
    }, []);

    /** Single teardown for EVERY exit path — success, failure, timeout, cancel,
     *  unmount, and an exception mid-probe. A screen that cannot be left
     *  because one path forgot to re-enable navigation is the worst version of
     *  this feature. */
    const finish = useCallback(() => {
        generationRef.current += 1;
        clearFallbackTimer();
        phaseRef.current = 'idle';
        setPhase('idle');
        setPendingCode(null);
    }, [clearFallbackTimer]);

    const runProbe = useCallback(
        async (code: string, generation: number) => {
            const previous = useAppLanguageStore.getState().appLanguage;
            let outcome: TranslationProbeOutcome = 'failed';
            try {
                outcome = await probeTranslationLanguage(code);
            } catch (err) {
                logger.warn('[useLanguageSwitch] Probe threw', {
                    code,
                    error: err instanceof Error ? err.message : String(err),
                });
                outcome = 'failed';
            }

            // Abandoned while we waited (cancel, timeout-driven exit, unmount).
            // The service has already recorded whatever it learned; the UI must
            // not act on it.
            if (generationRef.current !== generation) return;

            // 'device-unsupported' — this device has NO on-device translator
            // for ANY language, so the previous language is exactly as
            // untranslatable as the requested one. Reverting to it would be
            // theatre. ENGLISH IS THE FINAL FALLBACK: the user's rule, and the
            // one landing spot where the app is internally consistent, because
            // English is the source language of every translatable string, so
            // nothing on screen is waiting on a translator that does not exist.
            //
            // The cost, stated so it is not rediscovered as a bug: on such a
            // device the app language cannot be changed away from English at
            // all, even though the UI strings are BUNDLED and need no OS
            // translator. `deviceCanTranslate()` keys off `Device.isDevice`,
            // so that includes every simulator — a non-English UI cannot be
            // exercised there. This was chosen deliberately over committing the
            // requested language and letting the red-icon surface carry it.
            const fellBackToEnglish = outcome === 'device-unsupported';
            const appliedCode = fellBackToEnglish ? 'en' : code;

            if (outcome === 'success' || fellBackToEnglish) {
                // Applied with the code that actually won, never the requested
                // one — so the RTL restart prompt hanging off `onCommitted`
                // compares the right pair (leaving Arabic FOR English is still
                // a direction change and must still prompt).
                await setAppLanguage(appliedCode);
                optionsRef.current.onCommitted?.(appliedCode, previous);
            }

            finish();
            if (outcome !== 'success') {
                optionsRef.current.onResult?.({ code, outcome, fellBackToEnglish });
            }
        },
        [finish, setAppLanguage],
    );

    /** Step 1. Remember the choice; the screen now closes its picker. */
    const requestSwitch = useCallback(
        (code: string) => {
            if (busy) return;
            if (code === appLanguage) return;

            generationRef.current += 1;
            const generation = generationRef.current;
            setPendingCode(code);

            // English needs no probe (it is the source language) and Android's
            // ML Kit presents no system UI at all, so neither has a dismissal
            // race to wait out. Commit straight away.
            if (code === 'en' || Platform.OS !== 'ios') {
                phaseRef.current = 'probing';
                setPhase('probing');
                void runProbe(code, generation);
                return;
            }

            phaseRef.current = 'awaiting-dismiss';
            setPhase('awaiting-dismiss');
            clearFallbackTimer();
            fallbackTimerRef.current = setTimeout(() => {
                fallbackTimerRef.current = null;
                if (phaseRef.current !== 'awaiting-dismiss') return;
                if (generationRef.current !== generation) return;
                phaseRef.current = 'probing';
                setPhase('probing');
                void runProbe(code, generation);
            }, DISMISS_HANDSHAKE_FALLBACK_MS);
        },
        [appLanguage, busy, clearFallbackTimer, runProbe],
    );

    /** Step 2. Call from the picker modal's `onDismiss`, never from a timer. */
    const notifyPickerDismissed = useCallback(() => {
        clearFallbackTimer();
        const code = pendingCode;
        if (!code) return;
        if (phaseRef.current !== 'awaiting-dismiss') return;
        const generation = generationRef.current;
        phaseRef.current = 'probing';
        setPhase('probing');
        void runProbe(code, generation);
    }, [clearFallbackTimer, pendingCode, runProbe]);

    /**
     * The escape hatch, and the only one while a probe runs. Deliberately
     * synchronous and deliberately independent of the native call: it drops
     * the UI state and lets the orphaned probe resolve into nothing.
     */
    const cancel = useCallback(() => {
        if (!busy) return;
        logger.info('[useLanguageSwitch] Language switch cancelled by user', {
            code: pendingCode,
        });
        finish();
    }, [busy, finish, pendingCode]);

    // Android hardware / gesture back. Does NOT swallow the press silently —
    // it routes to the same cancel path, so a user pressing back gets out
    // rather than believing the phone has frozen.
    useEffect(() => {
        if (!busy) return;
        const sub = BackHandler.addEventListener('hardwareBackPress', () => {
            cancel();
            return true;
        });
        return () => sub.remove();
    }, [busy, cancel]);

    // Unmount teardown. Bumps the generation so an in-flight probe cannot
    // commit or set state on a dead screen.
    useEffect(
        () => () => {
            generationRef.current += 1;
            if (fallbackTimerRef.current) clearTimeout(fallbackTimerRef.current);
        },
        [],
    );

    return {
        /** Language being switched to, or null. */
        pendingCode,
        phase,
        /** True while the switch is in progress: lock navigation on this. */
        busy,
        requestSwitch,
        notifyPickerDismissed,
        cancel,
    };
}
