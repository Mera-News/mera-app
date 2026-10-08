// The ONE language selector: first launch's "Choose your language" list
// (FinalJourney #4, #10), also You > Settings > Language. The phone's language
// first and English second; each row is the language as it calls itself, its
// English name or "Your phone's language", a tick when picked, and a download
// button or the moving Mera mark while it gets ready. What is offered:
// language-options.ts. The list scrolls inside its box.
//
// It picks nothing itself: the host owns the switch (useLanguageSwitch) and
// what happens around it, and locks the list while a switch runs.

import React, { useMemo } from 'react';
import { FlatList, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import { useTranslation } from 'react-i18next';

import { LanguageRow } from '@/components/custom/auth/LanguageRow';
import { useColors } from '@/lib/theme/tokens';
import { isTranslationVerified } from '@/lib/translation-service';
import { offeredLanguages } from './language-options';

export interface LanguageSelectorProps {
    /** The language the app is in. */
    readonly appLanguage: string;
    /** The phone's own language (`phoneLanguage()`). */
    readonly phone: string;
    /** A switch is running; `pendingCode` is the language it is getting. */
    readonly busy: boolean;
    readonly pendingCode: string | null;
    /** No picks while true (a switch or a check is running). */
    readonly locked: boolean;
    readonly onPick: (code: string) => void;
    /** Row test ids are `${testIDPrefix}-${code}`. */
    readonly testIDPrefix: string;
    /** Settings: keep the app's own language listed even where the phone
     *  cannot translate into it. First launch leaves it off. */
    readonly keepCurrent?: boolean;
    readonly style?: StyleProp<ViewStyle>;
}

export default function LanguageSelector({
    appLanguage,
    phone,
    busy,
    pendingCode,
    locked,
    onPick,
    testIDPrefix,
    keepCurrent = false,
    style,
}: LanguageSelectorProps) {
    const { t } = useTranslation();
    const colors = useColors();
    const current = keepCurrent ? appLanguage : null;
    const languages = useMemo(() => offeredLanguages(phone, current), [phone, current]);

    return (
        <View
            pointerEvents={locked ? 'none' : 'auto'}
            accessibilityRole="radiogroup"
            style={[styles.list, { backgroundColor: colors.surface, borderColor: colors.line }, style]}
        >
            <FlatList
                data={languages}
                keyExtractor={(l) => l.code}
                renderItem={({ item }) => (
                    <LanguageRow
                        endonym={item.native}
                        english={item.name}
                        isPhoneLanguage={item.code === phone}
                        picked={item.code === (busy && pendingCode ? pendingCode : appLanguage)}
                        accessory={
                            busy && pendingCode === item.code
                                ? 'busy'
                                : item.code !== 'en' && !isTranslationVerified(item.code)
                                  ? 'download'
                                  : 'none'
                        }
                        onPress={() => onPick(item.code)}
                        onDownload={() => onPick(item.code)}
                        downloadA11yLabel={t('auth.track.downloadA11y', { language: item.native })}
                        phoneLanguageLabel={t('auth.track.phoneLanguage')}
                        testID={`${testIDPrefix}-${item.code}`}
                    />
                )}
            />
        </View>
    );
}

const styles = StyleSheet.create({
    list: { flex: 1, borderRadius: 16, borderWidth: StyleSheet.hairlineWidth, padding: 4, overflow: 'hidden' },
});
