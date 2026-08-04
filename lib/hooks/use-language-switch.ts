import { useCallback, useEffect, useRef, useState } from 'react';
import { BackHandler, Platform } from 'react-native';

import { useAppLanguageStore } from '@/lib/stores/app-language-store';
import {
    probeTranslationLanguage,
    resolveUiLocale,
    TranslationProbeOutcome,
} from '@/lib/translation-service';
import { previewLanguage } from '@/lib/i18n';
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
 *  4. Success → commit. Anything else → the user goes back to the language
 *     they were already using.
 *
 * THE UI LANGUAGE MOVES AT STEP 1, NOT STEP 4. The app's own strings are
 * bundled and need no download, so making them wait on a translation pack got
 * it exactly backwards: the instruction that unblocks the wait ("tap the
 * download icon") was rendered in a language the person waiting may not read.
 * So `requestSwitch` previews the target language immediately and the progress
 * card comes up in it.
 *
 * That makes step 4 a REAL revert rather than a no-op, on all three losing
 * endings — failure, timeout, and the user backing out. `finish()` owns it,
 * being the one teardown every exit already goes through.
 *
 * The revert is trivial for one reason worth protecting: the preview touches
 * i18next ONLY. The store's `appLanguage`, the database row, the RTL flag and
 * the persona sync all stay put until commit. So the store still holds the
 * language the user is really on for the whole probe, and undoing the preview
 * is just re-applying it. Do not "simplify" this by moving the store update
 * forward — the revert would then need to remember and restore four things
 * instead of reading one.
 *
 * A probe that resolves LATE, after the user already backed out, cannot undo
 * the revert: the generation check returns before it can commit or call
 * `finish()` a second time.
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
    // True between previewing a target language and undoing (or committing)
    // that preview. Guards the revert so it only ever fires against a preview
    // this hook actually made.
    const previewActiveRef = useRef(false);

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

    /**
     * Undo the preview by re-applying whatever the store says. Correct on every
     * ending without branching on which one it was:
     *
     *  - failure / timeout / cancel: the store never moved, so this puts the
     *    reader back where they started;
     *  - success and the English fallback: `setAppLanguage` has already moved
     *    the store to the language that won, so re-applying it is a no-op.
     *
     * That is the whole reason the preview deliberately leaves the store alone.
     */
    const revertPreview = useCallback(() => {
        if (!previewActiveRef.current) return;
        previewActiveRef.current = false;
        previewLanguage(useAppLanguageStore.getState().appLanguage);
    }, []);

    /** Single teardown for EVERY exit path — success, failure, timeout, cancel,
     *  unmount, and an exception mid-probe. A screen that cannot be left
     *  because one path forgot to re-enable navigation is the worst version of
     *  this feature — and now also a reader stranded in a language they picked
     *  by mistake, which is why the language revert lives here too rather than
     *  on each individual ending. */
    const finish = useCallback(() => {
        generationRef.current += 1;
        clearFallbackTimer();
        revertPreview();
        phaseRef.current = 'idle';
        setPhase('idle');
        setPendingCode(null);
    }, [clearFallbackTimer, revertPreview]);

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

            // Show the app in the language being adopted from this moment on,
            // so the progress card — and above all its "tap the download icon"
            // instruction — is readable by the person who chose it. Guarded by
            // `resolveUiLocale` because i18next is configured with
            // `fallbackLng: 'en'`: previewing a code with no bundle would
            // silently drop the reader into English, which is worse than
            // leaving them where they were. Every code the picker offers has a
            // bundle, so this guard should never fire.
            const uiLocale = resolveUiLocale(code);
            if (uiLocale) {
                previewActiveRef.current = true;
                previewLanguage(uiLocale);
            }

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
    // commit or set state on a dead screen — and undoes any preview still
    // standing, because the UI language is global: leaving the screen mid-probe
    // must not leave the whole app in a language that was never committed.
    // This is a genuinely separate exit from `finish()`, which unmount never
    // calls. Reading the store here is safe despite the empty deps: it is read
    // through `getState()`, not a captured value.
    useEffect(
        () => () => {
            generationRef.current += 1;
            if (fallbackTimerRef.current) clearTimeout(fallbackTimerRef.current);
            revertPreview();
        },
        [revertPreview],
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
