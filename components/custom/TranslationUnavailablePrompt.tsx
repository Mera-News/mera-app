import { usePathname } from 'expo-router';
import { useEffect, useRef } from 'react';
import { InteractionManager } from 'react-native';
import { useTranslation } from 'react-i18next';

import MeraToast from '@/components/custom/toast/MeraToast';
import { useToast } from '@/components/ui/toast';
import { probeLanguage } from '@/lib/hooks/use-language-switch';
import { useAppLanguage } from '@/lib/stores/app-language-store';
import {
    getNativeLanguageName,
    isTranslationVerified,
    noteLaunchVerifyFailed,
    TRANSLATION_STARTUP_VERIFY_TIMEOUT_MS,
    useTranslationBlocked,
} from '@/lib/translation-service';

/**
 * The notice for a language this phone can NEVER translate into, and the
 * once-per-launch re-verify of the saved language.
 *
 * Mounted once at the root, keyed on the app language. A persistent,
 * non-modal toast with no action: this iOS has no translator for the language
 * (`translationUnsupportedOnThisIos`), or the device has none at all
 * (`translationUnavailableOnThisDevice`). Those texts draw no failed glyph, so
 * this is their only explanation.
 *
 * A RETRYABLE block (the breaker: the pack may still be downloading) shows
 * nothing here: every failed text carries its own glyph and "Restart the app"
 * tooltip (TranslatableDynamic), and a second notice saying "tap to try
 * again" beside them contradicted it (owner).
 */
const TranslationUnavailablePrompt: React.FC = () => {
    const { t } = useTranslation();
    const appLanguage = useAppLanguage();
    const blocked = useTranslationBlocked(appLanguage);
    // The first-launch language list (AuthScreen, /login) shows its own
    // toast and falls back to English, so this card stays off that screen.
    const onLanguageList = usePathname() === '/login';
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
            // A non-permanent failure: a language this device has translated
            // into before stays blocked and is quietly re-verified on a
            // backoff; one it never has stays gated. The probe never re-runs.
            void probeLanguage(appLanguage, TRANSLATION_STARTUP_VERIFY_TIMEOUT_MS)
                .then((outcome) => {
                    if (outcome === 'failed' || outcome === 'timeout') return noteLaunchVerifyFailed(appLanguage);
                    return undefined;
                })
                .catch(() => {});
        });
        return () => handle.cancel();
    }, [appLanguage, blocked]);

    useEffect(() => {
        const openId = shownToastIdRef.current;

        // No permanent block (cleared, a retryable one, or the language changed): take the
        // prompt away rather than leaving a stale claim on screen.
        if (!permanent || onLanguageList) {
            if (openId && toast.isActive(openId)) toast.close(openId);
            shownToastIdRef.current = null;
            return;
        }

        if (openId && toast.isActive(openId)) return;

        const id = `translation-unavailable-${appLanguage}`;
        shownToastIdRef.current = id;

        const language = getNativeLanguageName(appLanguage) ?? appLanguage;

        const body = (
            <MeraToast
                tone="info"
                title={t('language.translationUnavailableTitle')}
                body={
                    blocked?.deviceUnsupported
                        ? // Distinct from the iOS-version case on purpose: telling someone to
                          // update iOS would be a lie when the device has no translator at all.
                          t('language.translationUnavailableOnThisDevice', { language })
                        : t('language.translationUnsupportedOnThisIos', { language })
                }
            />
        );

        toast.show({
            id,
            placement: 'top',
            duration: null,
            render: () => body,
        });
    }, [blocked, permanent, appLanguage, toast, t, onLanguageList]);

    return null;
};

export default TranslationUnavailablePrompt;
