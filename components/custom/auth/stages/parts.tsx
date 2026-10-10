import { MaterialIcons } from '@expo/vector-icons';
import React from 'react';
import { Keyboard, Pressable, View, type StyleProp, type ViewStyle } from 'react-native';
import { useTranslation } from 'react-i18next';

import { useColors } from '@/lib/theme/tokens';

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

function IconAction({
    icon,
    label,
    onPress,
    testID,
}: {
    icon: React.ComponentProps<typeof MaterialIcons>['name'];
    label: string;
    onPress: () => void;
    testID: string;
}) {
    const colors = useColors();
    return (
        <Pressable
            onPress={onPress}
            accessibilityRole="button"
            accessibilityLabel={label}
            style={[styles.iconAction, { borderColor: colors.line }]}
            testID={testID}
        >
            <MaterialIcons name={icon} size={22} color={colors.ink2} />
        </Pressable>
    );
}

export { BackArrow, GateIcon, IconAction };
