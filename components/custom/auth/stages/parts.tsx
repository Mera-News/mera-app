import { MaterialIcons } from '@expo/vector-icons';
import React from 'react';
import { Keyboard, Platform, Pressable, Text, View, type StyleProp, type ViewStyle } from 'react-native';
import { useTranslation } from 'react-i18next';

import { phoneUnsupportedKey } from '@/components/custom/auth/device-sign-in-copy';
import { useColors } from '@/lib/theme/tokens';
import { FAQ_URL } from '@/lib/config/branding';
import { openInAppBrowser, withAppLanguage } from '@/lib/web-browser-utils';

import { styles } from './styles';

// ── Small pieces ─────────────────────────────────────────────────────────────

function BackArrow({ onPress, style }: { onPress: () => void; style?: StyleProp<ViewStyle> }) {
    const { t } = useTranslation();
    const colors = useColors();
    return (
        <Pressable
            onPress={() => {
                Keyboard.dismiss();
                onPress();
            }}
            accessibilityRole="button"
            accessibilityLabel={t('common.back')}
            style={[styles.back, style]}
            testID="auth-back"
        >
            <MaterialIcons name="arrow-back" size={24} color={colors.ink} />
        </Pressable>
    );
}

function GateIcon({ name }: { name: React.ComponentProps<typeof MaterialIcons>['name'] }) {
    const colors = useColors();
    return (
        <View style={[styles.gateIcon, { backgroundColor: colors.surface, borderColor: colors.line }]}>
            <MaterialIcons name={name} size={28} color={colors.ink2} />
        </View>
    );
}

/** Email sign-in, demoted: a small grey link and the line saying who it is for. */
function LegacyEmailLink({
    label,
    onPress,
    testID,
    disabled,
}: {
    label: string;
    onPress: () => void;
    testID: string;
    disabled?: boolean;
}) {
    const { t } = useTranslation();
    const colors = useColors();
    return (
        <View style={styles.legacyEmail}>
            <Pressable
                onPress={onPress}
                disabled={disabled}
                accessibilityRole="link"
                hitSlop={8}
                style={styles.legacyEmailLink}
                testID={testID}
            >
                <Text style={[styles.legacyEmailText, { color: colors.ink3 }]}>{label}</Text>
            </Pressable>
            <Text style={[styles.legacyEmailHint, { color: colors.ink3 }]}>{t('auth.emailLegacyHint')}</Text>
        </View>
    );
}

/** The supported-phones list on the website, in the app's language. */
function openSupportedPhones() {
    void openInAppBrowser(`${withAppLanguage(FAQ_URL)}#supported-phones`);
}

/** The permanent "this phone can't sign in" block, shared by Begin and Consent. */
function PhoneUnsupported({ testID }: { testID: string }) {
    const { t } = useTranslation();
    const colors = useColors();
    return (
        <View style={styles.unsupportedBlock} testID={testID}>
            <View style={styles.unsupportedRow}>
                <MaterialIcons name="info-outline" size={18} color={colors.ink2} />
                <Text style={[styles.text, { color: colors.ink2 }]}>{t('auth.phoneNotSupported')}</Text>
            </View>
            <Text style={[styles.text, styles.centerText, { color: colors.ink2 }]}>
                {t(phoneUnsupportedKey(Platform.OS))}
            </Text>
            <Pressable
                onPress={openSupportedPhones}
                accessibilityRole="link"
                hitSlop={8}
                style={styles.legacyEmailLink}
                testID={`${testID}-supported-phones`}
            >
                <Text style={[styles.legacyEmailText, { color: colors.ink2 }]}>{t('auth.supportedPhones')}</Text>
            </Pressable>
        </View>
    );
}

export { BackArrow, GateIcon, LegacyEmailLink, PhoneUnsupported };
