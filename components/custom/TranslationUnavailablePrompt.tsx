import { useEffect, useRef } from 'react';
import { InteractionManager, Pressable } from 'react-native';
import { useTranslation } from 'react-i18next';

import { Toast, ToastDescription, ToastTitle, useToast } from '@/components/ui/toast';
import { useAppLanguage } from '@/lib/stores/app-language-store';
import {
    getNativeLanguageName,
    isTranslationVerified,
    probeTranslationLanguage,
    useTranslationBlocked,
} from '@/lib/translation-service';

/**
 * The ONE thing the user is told when on-device translation stops working.
 *
 * Mounted once at the root, keyed on the app language — so a reader who
 * scrolls twenty articles in an undownloaded language gets exactly one prompt,
 * not twenty. Everything else stays silent: articles quietly render the
 * server-side English (`title_en` / `description_en`) instead of interrupting
 * the read (see TranslatableDynamic).
 *
 * Modelled on OTAUpdatePrompt: a persistent, non-modal toast where the whole
 * surface IS the control. Deliberately NOT a bottom sheet — a bottom sheet
 * that keeps appearing is the bug being fixed here — and deliberately not a
 * blocking dialog, because the user is mid-article and nothing here needs an
 * answer before they can carry on reading.
 *
 * Two states, and only two, because two is all the platform lets us tell
 * apart honestly:
 *
 *  - **retryable** — the pack may still be downloading, or the download may
 *    have failed. Apple's bridge returns a localized string rather than an
 *    error code, so we cannot say which; the copy owns that uncertainty and
 *    one tap covers both (a finished download succeeds, a failed one gets a
 *    fresh attempt). One tap = one attempt: a failed retry re-blocks
 *    immediately rather than re-opening the loop.
 *  - **permanent** — this iOS version has no translator for the language at
 *    all, established from the same per-language version ladder the article
 *    notices use. Retrying can never work, so this variant carries no action.
 */
const TranslationUnavailablePrompt: React.FC = () => {
    const { t } = useTranslation();
    const appLanguage = useAppLanguage();
    const blocked = useTranslationBlocked(appLanguage);
    const toast = useToast();
    const shownToastIdRef = useRef<string | null>(null);
    const startupProbedRef = useRef<string | null>(null);

    const permanent = blocked?.permanent ?? false;

    // RE-VERIFY THE SAVED LANGUAGE ONCE PER LAUNCH.
    //
    // `verifiedLanguages` is in-memory and the native-call gate keys off it, so
    // without this a relaunch leaves every article in English forever: no
    // <TranslatableDynamic> is allowed to make the first call.
    //
    // It lives HERE, and not in the store's `hydrateFromDb`, deliberately.
    // Hydration runs during boot, while the root layout, the update gate and
    // the first screens are all still mounting — and this call can present
    // Apple's system sheet. Presenting it mid-transition is the crash this
    // wave is fixing; firing it from boot would have reintroduced the same
    // hazard at the least controlled moment in the app's life. This component
    // sits inside <NativeUpdateGate>, so the mandatory-update screen has
    // already resolved, and `runAfterInteractions` waits for the mount work to
    // drain before anything native happens.
    //
    // When the pack IS installed this resolves instantly with no UI at all;
    // the sheet only appears for a language whose assets are missing, which is
    // exactly the case the user needs to be asked about.
    useEffect(() => {
        if (appLanguage === 'en') return;
        if (startupProbedRef.current === appLanguage) return;
        if (isTranslationVerified(appLanguage)) return;
        if (blocked) return;
        startupProbedRef.current = appLanguage;
        const handle = InteractionManager.runAfterInteractions(() => {
            void probeTranslationLanguage(appLanguage).catch(() => {});
        });
        return () => handle.cancel();
    }, [appLanguage, blocked]);

    useEffect(() => {
        const openId = shownToastIdRef.current;

        // Unblocked again (a retry landed, or the language changed) — take the
        // prompt away rather than leaving a stale claim on screen.
        if (!blocked) {
            if (openId && toast.isActive(openId)) toast.close(openId);
            shownToastIdRef.current = null;
            return;
        }

        if (openId && toast.isActive(openId)) return;

        const id = `translation-unavailable-${appLanguage}`;
        shownToastIdRef.current = id;

        const language = getNativeLanguageName(appLanguage) ?? appLanguage;

        const body = (
            // `persistent` marks the `duration: null` below — this banner stays
            // until something closes it. It no longer changes the surface (every
            // toast is a flat panel now); see the prop's doc in
            // components/ui/toast.
            <Toast nativeID={id} action="info" variant="solid" persistent>
                <ToastTitle>{t('language.translationUnavailableTitle')}</ToastTitle>
                <ToastDescription>
                    {blocked?.deviceUnsupported
                        // Distinct from the iOS-version case on purpose:
                        // telling someone to update iOS would be a lie when
                        // the device has no translator at all.
                        ? t('language.translationUnavailableOnThisDevice', { language })
                        : permanent
                            ? t('language.translationUnsupportedOnThisIos', { language })
                            : t('language.translationUnavailableTapToRetry', { language })}
                </ToastDescription>
            </Toast>
        );

        toast.show({
            id,
            placement: 'top',
            duration: null,
            render: () =>
                permanent ? (
                    body
                ) : (
                    <Pressable
                        onPress={() => {
                            // The probe, not a plain translateText. Since the
                            // native-call gate landed, an unverified language
                            // is unreachable by any other caller — clearing
                            // the block and calling translateText would have
                            // produced no native call at all, i.e. a retry
                            // button that silently did nothing while looking
                            // like it had worked.
                            //
                            // The probe clears this language's failure state
                            // itself, so it is still exactly one deliberate
                            // attempt: one tap, one call, one sheet at most,
                            // and a failure re-blocks immediately.
                            void probeTranslationLanguage(appLanguage);
                        }}
                    >
                        {body}
                    </Pressable>
                ),
        });
    }, [blocked, permanent, appLanguage, toast, t]);

    return null;
};

export default TranslationUnavailablePrompt;
