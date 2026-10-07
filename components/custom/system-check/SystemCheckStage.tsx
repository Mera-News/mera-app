import { MaterialIcons } from '@expo/vector-icons';
import * as Device from 'expo-device';
import React, { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import { StyleSheet, Text, View } from 'react-native';
import Animated, { FadeIn, useReducedMotion } from 'react-native-reanimated';

import MeraLogo from '@/components/custom/MeraLogo';
import { Button, ButtonText } from '@/components/ui/button';
import { SegmentedControl } from '@/components/ui/segmented-control';
import { useAppearanceSetting } from '@/lib/theme/theme-store';
import { hapticLight } from '@/lib/haptics';
import { useAppLanguageStore } from '@/lib/stores/app-language-store';
import { useDisplayPrefsStore } from '@/lib/stores/display-prefs-store';
import { languageCheckStatus } from '@/lib/system-check/system-check';
import { useColors } from '@/lib/theme/tokens';
import {
    getNativeLanguageName,
    isTranslationVerified,
    subscribeTranslationAvailability,
    useTranslationBlocked,
} from '@/lib/translation-service';

/** The checks tick one after another at this pace (Journey #5). They are
 *  instant underneath; this is presentation. */
const STEP_MS = 150;

type RowState = 'pending' | 'ok' | 'info' | 'warn';

function CheckRow({ state, title, detail, testID }: { state: RowState; title: string; detail?: string; testID: string }) {
    const colors = useColors();
    const reduceMotion = useReducedMotion();
    return (
        <Animated.View
            entering={reduceMotion ? undefined : FadeIn.duration(150)}
            testID={testID}
            style={[styles.row, { borderColor: colors.line }]}
            accessible
            accessibilityLabel={detail ? `${title}. ${detail}` : title}
        >
            <View style={styles.rowIcon}>
                {state === 'pending' ? (
                    <MeraLogo size={20} animated />
                ) : (
                    <MaterialIcons
                        name={state === 'ok' ? 'check' : state === 'warn' ? 'error-outline' : 'info-outline'}
                        size={18}
                        color={state === 'ok' ? colors.positive : state === 'warn' ? colors.negative : colors.ink3}
                    />
                )}
            </View>
            <View style={styles.rowText}>
                <Text style={[styles.rowTitle, { color: colors.ink }]}>{title}</Text>
                {detail ? <Text style={[styles.rowDetail, { color: colors.ink3 }]}>{detail}</Text> : null}
            </View>
        </Animated.View>
    );
}

interface SystemCheckStageProps {
    /** The checks are done and the language is usable; move on. */
    onContinue: () => void;
    /** The first-launch track draws its own (hoisted) logo above the stage. */
    withLogo?: boolean;
    testID?: string;
}

/**
 * "Checking your phone" (FinalJourney #5), stop 3 of the first-launch track,
 * and the Settings > Display > System check screen. Rows tick in one by one,
 * each with the moving Mera mark while it runs: the phone is supported, Lite
 * mode on or off by what the phone can handle, translation for the picked
 * language (none for English), and on-device AI (the private cloud for now).
 *
 * The language is CHOSEN on the welcome list, which only lets a reader past
 * once it is usable, so this row only confirms it. Continue opens when the
 * language is usable or English: owner rule, no way past it. The stage never
 * probes: each probe may present Apple's download sheet, and the startup probe
 * (TranslationUnavailablePrompt) already runs one.
 */
export default function SystemCheckStage({ onContinue, withLogo = true, testID = 'system-check' }: SystemCheckStageProps) {
    const { t } = useTranslation();
    const colors = useColors();
    const liteMode = useDisplayPrefsStore((s) => s.liteMode);
    const appearance = useAppearanceSetting();
    const appLanguage = useAppLanguageStore((s) => s.appLanguage);

    const english = appLanguage === 'en';
    const rowCount = english ? 3 : 4;
    const [shown, setShown] = useState(0);
    useEffect(() => {
        if (shown >= rowCount) return;
        const id = setTimeout(() => setShown((n) => n + 1), STEP_MS);
        return () => clearTimeout(id);
    }, [shown, rowCount]);

    const blocked = useTranslationBlocked(appLanguage) != null;
    const verified = useSyncExternalStore(subscribeTranslationAvailability, () => isTranslationVerified(appLanguage));
    const languageStatus = languageCheckStatus({
        appLanguage,
        verified,
        blocked,
        isPhysicalDevice: Device.isDevice !== false,
    });

    const [saving, setSaving] = useState(false);
    const ready = shown >= rowCount && languageStatus === 'passed';
    const handleContinue = useCallback(async () => {
        if (saving || !ready) return;
        setSaving(true);
        void hapticLight();
        try {
            // Persist the language row even when the reader kept the default:
            // the choice is a fact about this install from now on.
            await useAppLanguageStore.getState().setAppLanguage(useAppLanguageStore.getState().appLanguage);
        } catch {
            // The store already logged it; the reader still moves on.
        }
        onContinue();
    }, [ready, onContinue, saving]);

    const languageName = getNativeLanguageName(appLanguage) ?? appLanguage;
    const rows: { key: string; state: RowState; title: string; detail?: string }[] = [
        { key: 'phone', state: 'ok', title: t('systemCheck.phoneSupportedLine') },
        { key: 'mode', state: 'ok', title: t(liteMode ? 'systemCheck.liteOn' : 'systemCheck.liteOff') },
        ...(english
            ? []
            : [
                  {
                      key: 'language',
                      state: (languageStatus === 'passed' ? 'ok' : languageStatus === 'checking' ? 'pending' : 'warn') as RowState,
                      title: t('systemCheck.translationFor', { language: languageName }),
                  },
              ]),
        { key: 'ai', state: 'info', title: t('systemCheck.aiTitle'), detail: t('systemCheck.aiCloud') },
    ];

    return (
        <View testID={testID} style={styles.root}>
            {withLogo ? (
                <View style={styles.logo}>
                    <MeraLogo size={72} animated />
                </View>
            ) : null}
            <Text accessibilityRole="header" style={[styles.title, { color: colors.ink }]}>
                {t('systemCheck.title')}
            </Text>
            <Text style={[styles.subtitle, { color: colors.ink3 }]}>{t('systemCheck.subtitle')}</Text>

            <View style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.line }]}>
                {rows.map((row, i) =>
                    i < shown ? (
                        <CheckRow key={row.key} testID={`${testID}-${row.key}`} state={row.state} title={row.title} detail={row.detail} />
                    ) : i === shown ? (
                        <CheckRow key={row.key} testID={`${testID}-${row.key}`} state="pending" title={row.title} />
                    ) : null,
                )}
            </View>

            {/* The theme row (Journey #20): the same Appearance control as
                Settings > Display, starting at the phone's look. Hidden until
                light ships (THEME_SWITCH_LIVE). */}
            {appearance.live ? (
                <View style={[styles.themeRow, { backgroundColor: colors.surface, borderColor: colors.line }]}>
                    <View style={styles.rowText}>
                        <Text style={[styles.rowTitle, { color: colors.ink }]}>{t('display.appearanceTitle')}</Text>
                        <Text style={[styles.rowDetail, { color: colors.ink3 }]}>{t('display.appearanceHint')}</Text>
                    </View>
                    <SegmentedControl
                        accessibilityLabel={t('display.appearanceTitle')}
                        value={appearance.mode}
                        onChange={appearance.setMode}
                        options={[
                            { value: 'light', label: t('display.appearanceLight'), icon: 'light-mode' },
                            { value: 'dark', label: t('display.appearanceDark'), icon: 'dark-mode' },
                        ]}
                        testID={`${testID}-theme`}
                    />
                </View>
            ) : null}

            <View style={styles.spacer} />
            <Button action="primary" onPress={handleContinue} isDisabled={!ready || saving} testID={`${testID}-continue`}>
                <ButtonText>{t('auth.continue')}</ButtonText>
            </Button>
        </View>
    );
}

const styles = StyleSheet.create({
    root: { flex: 1, paddingHorizontal: 20, paddingBottom: 16 },
    logo: { alignItems: 'center', marginTop: 24, marginBottom: 16 },
    title: { fontSize: 24, fontWeight: '700', textAlign: 'center' },
    subtitle: { fontSize: 14, textAlign: 'center', marginTop: 6, marginBottom: 20 },
    card: { borderRadius: 16, borderWidth: StyleSheet.hairlineWidth, paddingHorizontal: 14 },
    row: { flexDirection: 'row', alignItems: 'flex-start', gap: 12, paddingVertical: 12 },
    rowIcon: { width: 22, alignItems: 'center', paddingTop: 1 },
    rowText: { flex: 1, gap: 2 },
    rowTitle: { fontSize: 15 },
    rowDetail: { fontSize: 13, lineHeight: 18 },
    spacer: { flex: 1 },
    themeRow: { borderRadius: 16, borderWidth: StyleSheet.hairlineWidth, padding: 14, marginTop: 12, gap: 12 },
});
