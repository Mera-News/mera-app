import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { AppState, BackHandler } from 'react-native';

import { useAppLanguageStore } from '@/lib/stores/app-language-store';
import {
    probeTranslationLanguage,
    resolveUiLocale,
    TranslationProbeOutcome,
} from '@/lib/translation-service';
import { previewLanguage } from '@/lib/i18n';
import logger from '@/lib/logger';

/**
 * The language-switch state machine, shared by Settings > Language and the
 * first-launch list (`components/custom/auth/WelcomeStage.tsx`).
 *
 * WHY A SHARED HOOK AND NOT TWO COPIES. This is a state machine with a
 * cancellation token, a navigation lock and a revert path, and an earlier
 * pre-auth picker had a copy of an older version that was one line different;
 * that line was a native crash. Two copies of this cannot be allowed to drift.
 *
 * NO PICKER MODAL, ON PURPOSE. Both callers pick from an INLINE list
 * (auth/LanguageSelector), so the probe runs at once. The probe presents
 * Apple's system download sheet from inside the native call, and presenting it
 * while a view controller is mid-dismissal crashed the app on every language
 * switch. A caller that puts the list in a modal again must wait for the
 * modal's `onDismiss` before calling `requestSwitch`, never a timer guess.
 *
 * THE SEQUENCE:
 *
 *  1. `requestSwitch(code)`: previews the language (unless `preview: false`)
 *     and starts the probe. The screen shows its progress and a cancel.
 *  2. Success → commit. Anything else → the user goes back to the language
 *     they were already using.
 *
 * THE UI LANGUAGE MOVES AT STEP 1, NOT STEP 2. The app's own strings are
 * bundled and need no download, so making them wait on a translation pack got
 * it exactly backwards: the instruction that unblocks the wait ("tap the
 * download icon") was rendered in a language the person waiting may not read.
 * So `requestSwitch` previews the target language immediately and the progress
 * card comes up in it.
 *
 * That makes step 2 a REAL revert rather than a no-op, on all three losing
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

/**
 * The probe calls in flight right now, in start order. This is the ONLY signal
 * JS has for Apple's download sheet: expo-translate-text sends no presented or
 * dismissed event, it just holds the promise open while the sheet is up. The
 * first-launch download notice reads it, so every probe the app fires goes
 * through `probeLanguage`, never `probeTranslationLanguage`.
 *
 * Each call is its own object, not just its code: a retry of the same language
 * while an abandoned call is still open must count as a new probe.
 */
export interface Probe {
    readonly code: string;
}
/** Probes during which iOS reported the app not active: the one outside sign
 *  of Apple's download sheet. Watched from the moment the call starts, so a
 *  brief inactive blip while the page is still rendering is never missed. */
const sheetSeenProbes = new WeakSet<Probe>();
export const probeSawSheet = (probe: Probe): boolean => sheetSeenProbes.has(probe);
const probesInFlight: Probe[] = [];
const probeListeners = new Set<() => void>();
const emitProbes = () => probeListeners.forEach((l) => l());

export async function probeLanguage(code: string, timeoutMs?: number): Promise<TranslationProbeOutcome> {
    const probe: Probe = { code };
    if (AppState.currentState !== 'active') sheetSeenProbes.add(probe);
    const sub = AppState.addEventListener('change', (state) => {
        if (state !== 'active') sheetSeenProbes.add(probe);
    });
    probesInFlight.push(probe);
    emitProbes();
    try {
        return await probeTranslationLanguage(code, timeoutMs);
    } finally {
        sub.remove();
        probesInFlight.splice(probesInFlight.indexOf(probe), 1);
        emitProbes();
    }
}

const subscribeProbes = (l: () => void) => {
    probeListeners.add(l);
    return () => probeListeners.delete(l);
};

/**
 * The NEWEST probe in flight, or null. Newest, because a probe whose sheet never
 * came can stay open natively for its whole timeout, and the reader's next pick
 * must get its own notice and its own no-sheet fallback (WelcomeStage).
 */
export const currentProbe = (): Probe | null => probesInFlight[probesInFlight.length - 1] ?? null;

export function useCurrentProbe(): Probe | null {
    return useSyncExternalStore(subscribeProbes, currentProbe);
}

export type LanguageSwitchPhase =
    | 'idle'
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

interface UseLanguageSwitchOptions {
    /** Fired after the new language has been applied. */
    readonly onCommitted?: (code: string, previousCode: string) => void;
    /** Fired once the attempt ends in anything other than a plain commit. */
    readonly onResult?: (result: LanguageSwitchResult) => void;
    /**
     * Show the UI in the new language while it is being checked (default).
     * The first-launch list passes false: its page turns only once the
     * language is ready (FinalJourney "In your language").
     */
    readonly preview?: boolean;
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
    // True between previewing a target language and undoing (or committing)
    // that preview. Guards the revert so it only ever fires against a preview
    // this hook actually made.
    const previewActiveRef = useRef(false);

    // Latest callbacks, so the probe effect never depends on an unstable
    // inline identity.
    const optionsRef = useRef(options);
    optionsRef.current = options;

    const busy = phase !== 'idle';

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
        revertPreview();
        setPhase('idle');
        setPendingCode(null);
    }, [revertPreview]);

    const runProbe = useCallback(
        async (code: string, generation: number) => {
            const previous = useAppLanguageStore.getState().appLanguage;
            let outcome: TranslationProbeOutcome = 'failed';
            try {
                outcome = await probeLanguage(code);
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

    /** Step 1. Preview the language and probe it. The native call starts
     *  here, outside any `setState` updater: React may run an updater twice,
     *  and two calls would be two concurrent sheets. */
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
            if (uiLocale && optionsRef.current.preview !== false) {
                previewActiveRef.current = true;
                previewLanguage(uiLocale);
            }

            setPhase('probing');
            void runProbe(code, generation);
        },
        [appLanguage, busy, runProbe],
    );

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
        cancel,
    };
}
