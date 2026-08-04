import { useEffect, useRef } from 'react';
import { Pressable } from 'react-native';
import { useTranslation } from 'react-i18next';

import { Toast, ToastDescription, ToastTitle, useToast } from '@/components/ui/toast';
import { useAppLanguage } from '@/lib/stores/app-language-store';
import {
    armTranslationRetry,
    getNativeLanguageName,
    translateText,
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

    const permanent = blocked?.permanent ?? false;

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
            <Toast nativeID={id} action="info" variant="solid">
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
                            // Deliberate, language-wide, and strictly one
                            // attempt — armTranslationRetry leaves the counter
                            // one short of the threshold, so if this probe
                            // fails the language re-blocks on that single
                            // failure instead of re-arming the loop.
                            armTranslationRetry(appLanguage);
                            void translateText('Hello', appLanguage);
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
