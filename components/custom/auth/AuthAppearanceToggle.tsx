import { MaterialIcons } from '@expo/vector-icons';
import React from 'react';
import { useTranslation } from 'react-i18next';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { DECORATIVE_ICON_A11Y } from '@/components/custom/decorative-icon';
import { Pressable } from '@/components/ui/pressable';
import { useAppearanceSetting } from '@/lib/theme/theme-store';
import { useColors } from '@/lib/theme/tokens';

import { LOGO_TOP } from './stages/styles';

const SIZE = 44;

/**
 * Light or dark before sign-in. Top right, because the terms screen's back arrow
 * holds the top left. The setting is the device's, so it survives sign-in.
 */
export default function AuthAppearanceToggle() {
    const { t } = useTranslation();
    const colors = useColors();
    const insets = useSafeAreaInsets();
    const { mode, setMode, live } = useAppearanceSetting();
    if (!live) return null;
    const dark = mode === 'dark';
    return (
        <Pressable
            onPress={() => setMode(dark ? 'light' : 'dark')}
            accessibilityRole="button"
            accessibilityLabel={t('display.appearanceTitle')}
            accessibilityValue={{ text: t(dark ? 'display.appearanceDark' : 'display.appearanceLight') }}
            testID="auth-appearance"
            style={{
                position: 'absolute',
                top: insets.top + 16 + (LOGO_TOP - SIZE) / 2,
                right: 20,
                width: SIZE,
                height: SIZE,
                borderRadius: SIZE / 2,
                borderWidth: 1,
                borderColor: colors.line,
                backgroundColor: colors.surface,
                alignItems: 'center',
                justifyContent: 'center',
            }}
        >
            <MaterialIcons {...DECORATIVE_ICON_A11Y} name={dark ? 'light-mode' : 'dark-mode'} size={20} color={colors.ink} />
        </Pressable>
    );
}
