import AbstractGradientBackdrop from '@/components/custom/AbstractGradientBackdrop';
import { Box } from '@/components/ui/box';
import { GluestackUIProvider } from '@/components/ui/gluestack-ui-provider';
import LanguageSelector from '@/components/custom/auth/LanguageSelector';
import { Help } from '@/components/custom/you/rows';
import { getLanguageName } from '@/lib/translation-service';
import { requestRestart } from '@/lib/app-restart';
import { phoneLanguage, useAppLanguageStore } from '@/lib/stores/app-language-store';
import { useLanguageSwitch, LanguageSwitchResult } from '@/lib/hooks/use-language-switch';
import LanguageSwitchProgress from '@/components/custom/config-mera/LanguageSwitchProgress';
import LanguageDownloadHint from '@/components/custom/config-mera/LanguageDownloadHint';
import React, { useCallback, useMemo } from 'react';
import { Platform, View } from 'react-native';
import { showDialog } from '@/lib/dialog';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import DrillDownHeader, { SUBPAGE_TOP_GAP } from '@/components/custom/config-panel/DrillDownHeader';

interface LanguageSettingsScreenProps {
    onBack?: () => void;
    /** Lets the route lock the stack's swipe-back gesture while a switch runs. */
    onBusyChange?: (busy: boolean) => void;
}

const RTL_CODES = new Set(['ar', 'he']);

const LanguageSettingsScreen: React.FC<LanguageSettingsScreenProps> = ({ onBack, onBusyChange }) => {
    const insets = useSafeAreaInsets();
    const { t } = useTranslation();
    const appLanguage = useAppLanguageStore((s) => s.appLanguage);
    const phone = useMemo(() => phoneLanguage(), []);

    // Only fires on a language that was actually applied, so a failed attempt
    // can never prompt for a restart the user did not ask for.
    const handleCommitted = useCallback(
        (code: string, previousCode: string) => {
            if (RTL_CODES.has(previousCode) === RTL_CODES.has(code)) return;
            void showDialog({
                title: t('language.restartRequired'),
                body: t('language.restartDescription'),
                cancelLabel: t('language.later'),
                confirmLabel: t('language.restart'),
            }).then((restart) => {
                // Through the one restart authority, not a bare
                // reloadAsync(): lib/app-restart.ts holds this off while a
                // purchase or a credential write is mid-flight.
                if (restart) void requestRestart('language');
            });
        },
        [t],
    );

    // Every non-success ending is reported by name, and names the language the
    // user is left on — an attempt that silently does nothing is the thing
    // being fixed here.
    const handleResult = useCallback(
        ({ code, outcome, fellBackToEnglish }: LanguageSwitchResult) => {
            // ENGLISH names here, not endonyms — these strings are prose in the
            // reader's CURRENT language, explaining that the switch did not
            // happen. `getNativeLanguageName` gave "Couldn't switch to العربية",
            // which drops RTL script into the middle of an LTR sentence, and
            // names the language in a script the reader may not read (the exact
            // reasoning ArticleMetaRow already follows). The spinner TITLE keeps
            // the endonym on purpose: there it is a label for what you are
            // getting, not a word inside a sentence.
            const language = getLanguageName(code) ?? code;
            const current = getLanguageName(
                useAppLanguageStore.getState().appLanguage,
            ) ?? 'English';
            // Read AFTER the hook applied it, so `current` is already English
            // here — the body names the landing spot rather than re-deriving it.
            if (fellBackToEnglish) {
                void showDialog({
                    title: t('language.switchFailedTitle', { language }),
                    body: t('language.switchDeviceUnsupportedBody', { language }),
                    confirmLabel: t('common.ok'),
                });
                return;
            }
            const body = outcome === 'timeout'
                ? t('language.switchTimedOutBody', { language, previous: current })
                : outcome === 'language-unsupported'
                    ? t('language.switchUnsupportedBody', { language, previous: current })
                    : t('language.switchFailedBody', { language, previous: current });
            void showDialog({ title: t('language.switchFailedTitle', { language }), body, confirmLabel: t('common.ok') });
        },
        [t],
    );

    // The selector is inline (no picker modal to wait for), so the probe runs
    // at once. The UI previews the new language while it is checked.
    const { pendingCode, busy, requestSwitch, cancel } = useLanguageSwitch({
        onCommitted: handleCommitted,
        onResult: handleResult,
        immediate: true,
    });

    React.useEffect(() => {
        onBusyChange?.(busy);
    }, [busy, onBusyChange]);

    const pick = (code: string) => {
        if (busy || code === appLanguage) return;
        requestSwitch(code);
    };

    const handleBack = () => {
        if (busy) return;
        onBack?.();
    };

    return (
        <GluestackUIProvider>
            <Box className="flex-1">
                {/* Page background. Must be the FIRST child so it paints behind
                    everything else on the page. */}
                <AbstractGradientBackdrop />

                <Box style={{ paddingTop: insets.top }}>
                    <DrillDownHeader
                        title={t('language.title')}
                        onBack={onBack ? handleBack : undefined}
                        backTestID="language-back"
                        // Locked while a switch runs: Apple's system sheet
                        // must not be left half-done.
                        backDisabled={busy}
                    />
                </Box>

                {/* The first-launch selector itself (auth/LanguageSelector), applied
                    on pick. Above it: one line for the phone it is on, the
                    iOS download hint (read before Apple's sheet covers the lower
                    half), and the switch's progress. The list scrolls in its box. */}
                <View style={{ flex: 1, minHeight: 0, paddingHorizontal: 14, paddingTop: SUBPAGE_TOP_GAP, paddingBottom: insets.bottom + 16, gap: 12 }}>
                    <Help>{Platform.OS === 'ios' ? t('language.oneParaIos') : t('language.oneParaAndroid')}</Help>
                    <LanguageDownloadHint />
                    {busy && pendingCode ? <LanguageSwitchProgress code={pendingCode} onCancel={cancel} /> : null}
                    <LanguageSelector
                        appLanguage={appLanguage}
                        phone={phone}
                        busy={busy}
                        pendingCode={pendingCode}
                        locked={busy}
                        onPick={pick}
                        testIDPrefix="language-option"
                        keepCurrent
                    />
                </View>
            </Box>
        </GluestackUIProvider>
    );
};

export default LanguageSettingsScreen;
